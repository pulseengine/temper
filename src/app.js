import path from 'path';
import fs from 'node:fs';
import { fileURLToPath } from 'url';
import { createDashboardHandler, DEPLOY_SHA } from './dashboard.js';
import { getConfig, getControllerRepoConfig, getChatopsRepoConfig } from './config.js';
import { getLogger, setLogger } from './logger.js';
import { configureRepository } from './repository.js';
import {
  checkOrganizationMembership,
  synchronizeAllRepositories,
  generateOrganizationAnalysisReport
} from './organization.js';
import { generateConfigurationReport } from './reporting.js';
import {
  checkDependabotConfiguration,
  checkExistingDependabotConfig,
  extractLabelsFromConfig,
  fixDependabotPRLabels,
  generateDependabotConfig,
  applyDependabotConfig
} from './dependabot.js';
import { ensureLabelsExist } from './labels.js';
import { handleSignedCommitMerge, checkPRMergeStrategy } from './merge-strategy.js';
import { reviewPullRequest, updateReviewStatus, setRateLimitStore } from './ai-review.js';
import { isProcessed, markProcessed, setIdempotencyStore } from './idempotency.js';
import { triggerSelfUpdate } from './self-update.js';
import { defaultQueue } from './queue.js';
import { applySecurityMiddleware } from './middleware.js';
import { initTaskStore } from './task-store.js';
import { createScheduler } from './scheduler.js';
import { initKVStore } from './persistent-kv.js';
import { provisionRepo, parseIssueFormBody, validateProvisionRequest } from './provisioning.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Module-level state for the task store and scheduler
let _taskStore = null;
let _scheduler = null;

function getTaskStore() { return _taskStore; }
function getScheduler() { return _scheduler; }
function getEnqueueTask() {
  return _taskStore
    ? (type, key, payload) => _taskStore.enqueue(type, key, payload)
    : null;
}

/**
 * Octokit's `.issues.X` namespace is unreliable in Probot v14 — frequently
 * undefined on `pull_request.opened` AND `issue_comment.created` events
 * (see git history of `src/ai-review.js` and PR #22 for the hours of
 * production silence this caused). Always go through `.request(route, args)`
 * — that primitive is consistently available regardless of event context.
 *
 * These helpers exist so call sites stay short and the routes are declared
 * once, not 28 times.
 */
const issueOps = {
  createComment: (octokit, args) =>
    octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', args),
  updateComment: (octokit, args) =>
    octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', args),
  deleteComment: (octokit, args) =>
    octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', args),
  createIssue: (octokit, args) =>
    octokit.request('POST /repos/{owner}/{repo}/issues', args)
};

/**
 * Dispatch a chatops:<command> issue form to the equivalent action.
 * Called only when the issue lives in the configured `chatops_repo.repo`
 * and carries a label of the form `chatops:<command>`.
 *
 * Replies to the source issue and (on success) closes it. The issue
 * therefore *is* the audit trail: form fields + bot replies + close
 * reason, all in one place.
 */
async function handleChatopsIssue(context, label, sender, issue, repository) {
  const config = getConfig();
  const owner = repository.owner.login;
  const repo = repository.name;
  const issueNumber = issue.number;
  const targetOrg = config?.organization || owner;

  const allowedUsers = config?.allowed_command_users || [];
  if (allowedUsers.length > 0 && !allowedUsers.includes(sender?.login)) {
    await issueOps.createComment(context.octokit, {
      owner, repo, issue_number: issueNumber,
      body: `❌ You are not authorised to trigger ChatOps. Allowed: ${allowedUsers.join(', ')}.`
    });
    return;
  }

  const commentBack = (body) =>
    issueOps.createComment(context.octokit, { owner, repo, issue_number: issueNumber, body });

  const closeIssue = () =>
    context.octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
      owner, repo, issue_number: issueNumber, state: 'closed', state_reason: 'completed'
    });

  const command = label.replace(/^chatops:/, '');

  switch (command) {
    case 'sync-all-repos': {
      await commentBack('🔄 Starting org-wide sync — this can take a few minutes.');
      const result = await synchronizeAllRepositories(context.octokit, targetOrg);
      await commentBack(result.success
        ? `✅ Synchronized ${result.repositoriesProcessed} repositories.`
        : `❌ Sync failed: ${result.error}`);
      if (result.success) await closeIssue();
      return;
    }

    case 'configure-repo': {
      const fields = parseIssueFormBody(issue.body || '');
      const repoSpec = fields.repository || fields.repo || fields['repository (owner/repo or just repo name in this org)'];
      if (!repoSpec) {
        await commentBack('❌ Missing field "Repository". Please re-open the issue with a value.');
        return;
      }
      const [specOwner, specRepo] = repoSpec.includes('/')
        ? repoSpec.split('/')
        : [targetOrg, repoSpec];
      const repoData = await context.octokit.request('GET /repos/{owner}/{repo}', {
        owner: specOwner, repo: specRepo
      }).catch((err) => ({ error: err }));
      if (repoData.error) {
        await commentBack(`❌ Could not access ${specOwner}/${specRepo}: ${repoData.error.message}`);
        return;
      }
      await commentBack(`🔄 Configuring ${specOwner}/${specRepo}…`);
      const result = await configureRepository(context.octokit, repoData.data, undefined, {
        enqueueTask: getEnqueueTask()
      });
      await commentBack(result.success
        ? `✅ Configured ${specOwner}/${specRepo}.`
        : `❌ Failed: ${result.error}`);
      if (result.success) await closeIssue();
      return;
    }

    case 'analyze-org': {
      await commentBack('🔄 Generating org analysis report…');
      const reportBody = await generateOrganizationAnalysisReport(context.octokit, targetOrg);
      const reportIssue = await issueOps.createIssue(context.octokit, {
        owner, repo,
        title: `Organization Analysis Report - ${new Date().toISOString().split('T')[0]}`,
        body: reportBody,
        labels: ['analysis', 'report', 'automation']
      });
      await commentBack(`✅ Report posted as issue #${reportIssue.data.number}`);
      await closeIssue();
      return;
    }

    case 'review-pr': {
      const fields = parseIssueFormBody(issue.body || '');
      const repoSpec = fields.repository || fields.repo;
      const prRaw = fields['pr number'] || fields.pr;
      const prNum = parseInt(prRaw, 10);
      if (!repoSpec || !prNum) {
        await commentBack('❌ Need both "Repository" and "PR number".');
        return;
      }
      const [specOwner, specRepo] = repoSpec.includes('/')
        ? repoSpec.split('/')
        : [targetOrg, repoSpec];
      await commentBack(`🔄 Triggering AI review on ${specOwner}/${specRepo}#${prNum}…`);
      const result = await reviewPullRequest(context.octokit, specOwner, specRepo, prNum);
      await commentBack(result.success
        ? `✅ Review posted on https://github.com/${specOwner}/${specRepo}/pull/${prNum}.`
        : `❌ Review failed: ${result.error}`);
      if (result.success) await closeIssue();
      return;
    }

    default: {
      await commentBack(`❌ Unknown ChatOps label: \`${label}\`.`);
    }
  }
}

function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '0');
}

function createCustomRoutesHandler() {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      applySecurityHeaders(res);
      const healthData = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: DEPLOY_SHA || '1.0.0',
        queue: defaultQueue.stats()
      };
      if (_taskStore) {
        healthData.tasks = _taskStore.getStats();
      }
      if (_scheduler) {
        healthData.scheduler = { running: _scheduler.isRunning() };
      }
      const body = JSON.stringify(healthData);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return true;
    }

    if (req.method === 'GET' && pathname === '/webhook') {
      applySecurityHeaders(res);
      const body = JSON.stringify({
        message: 'Webhook endpoint ready',
        events: ['repository', 'issue_comment', 'pull_request', 'push']
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return true;
    }

    return false;
  };
}

function registerApp(app, options = {}) {
  const { getRouter, addHandler } = options;
  app.on('repository.created', async (context) => {
    if (context.log) setLogger(context.log);
    const deliveryId = context.id;
    if (deliveryId && isProcessed(deliveryId)) {
      getLogger().info({ deliveryId }, 'Skipping duplicate webhook delivery');
      return;
    }

    if (!context.octokit) {
      getLogger().warn('No context.octokit - skipping event');
      return;
    }

    const config = getConfig();
    const { repository, organization } = context.payload;

    const targetOrg = config?.organization || process.env.ORGANIZATION;
    if (!targetOrg) {
      getLogger().warn('No target organization configured — skipping repository.created event');
      return;
    }
    const repoOrg = organization?.login || repository.owner?.login;

    if (repoOrg === targetOrg) {
      getLogger().info({ repo: repository.full_name }, 'New repository created');

      // Check whether the default branch exists yet. Rulesets work on empty
      // repos (they target ref patterns, not branches), so we no longer bail
      // when the branch is missing — we just defer the branch-scoped work.
      const defaultBranch = repository.default_branch || 'main';
      const owner = repository.owner.login;
      const repoName = repository.name;
      let branchReady = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await context.octokit.repos.getBranch({
            owner,
            repo: repoName,
            branch: defaultBranch
          });
          branchReady = true;
          break;
        } catch (err) {
          if (err.status === 404) {
            if (attempt < 3) {
              await new Promise((resolve) => setTimeout(resolve, 2000));
            }
          } else {
            getLogger().warn(
              { repo: repository.full_name, err: err.message },
              'Unexpected error checking for default branch'
            );
            break;
          }
        }
      }

      if (!branchReady) {
        getLogger().info(
          { repo: repository.full_name, branch: defaultBranch },
          'Default branch missing — applying partial configuration; remainder deferred until first push'
        );
      }

      const result = await configureRepository(context.octokit, repository, undefined, {
        enqueueTask: getEnqueueTask(),
        skipBranchScopedWork: !branchReady
      });

      if (repository.has_issues) {
        try {
          await issueOps.createIssue(context.octokit,{
            owner,
            repo: repoName,
            title: 'Repository Configuration',
            body: result.success
              ? '✅ This repository has been automatically configured with standard merge settings and branch protection.'
              : `❌ Configuration failed: ${result.error}`,
            labels: ['automation', 'configuration']
          });
        } catch (issueErr) {
          getLogger().warn(
            { repo: repository.full_name, err: issueErr.message },
            'Failed to create configuration issue — issues may not be fully initialized yet'
          );
        }
      }
    }

    if (deliveryId) markProcessed(deliveryId);
  });

  // Issue-driven repo provisioning (Cut A): user files an issue in the
  // controller repo with the issue form; we validate and enqueue.
  app.on('issues.opened', async (context) => {
    if (context.log) setLogger(context.log);
    const deliveryId = context.id;
    if (deliveryId && isProcessed(deliveryId)) return;

    // Bug #6: every code path that *touches* an issue in the chatops/
    // controller repo must mark the delivery processed — including auth-
    // failure replies and exceptions. Otherwise Probot's webhook retry
    // (~5 attempts over 8 hours on 5xx/timeout) fires the side-effecting
    // path again. Symptom: duplicate "❌ unauthorised" comments, duplicate
    // analysis-report issues, duplicate provisioning enqueues.
    try {
      const { issue, repository, sender } = context.payload;
      const fullName = repository.full_name;

      // ChatOps issue forms in the admin repo: a `chatops:<command>` label on
      // a newly-opened issue triggers the corresponding ChatOps action,
      // bot replies on the issue, optionally closes it.
      const chatopsCfg = getChatopsRepoConfig();
      if (chatopsCfg?.enabled && fullName === chatopsCfg.repo) {
        const chatopsLabel = (issue.labels || [])
          .map((l) => l?.name)
          .find((n) => typeof n === 'string' && n.startsWith('chatops:'));
        if (chatopsLabel) {
          await handleChatopsIssue(context, chatopsLabel, sender, issue, repository);
          return;
        }
      }

      const ctrl = getControllerRepoConfig();
      if (!ctrl?.enabled) return;
      if (fullName !== ctrl.repo) return;

      const expectedLabel = ctrl.label || 'repo-request';
      const hasLabel = (issue.labels || []).some((l) => l.name === expectedLabel);
      if (!hasLabel) return;

      const fields = parseIssueFormBody(issue.body || '');
      const validation = validateProvisionRequest(fields);

      const owner = repository.owner.login;
      const repo = repository.name;

      if (!validation.valid) {
        await issueOps.createComment(context.octokit,{
          owner,
          repo,
          issue_number: issue.number,
          body: `❌ Provisioning request rejected: ${validation.error}`
        });
        return;
      }

      const enqueueTask = getEnqueueTask();
      if (!enqueueTask) {
        getLogger().warn('Task store not initialized — cannot enqueue provision-repo task');
        await issueOps.createComment(context.octokit,{
          owner,
          repo,
          issue_number: issue.number,
          body: '⚠️  Provisioning is not currently available (task store offline). Please retry later.'
        });
        return;
      }

      enqueueTask(
        'provision-repo',
        `provision-repo:${owner}/${repo}#${issue.number}`,
        {
          sourceOwner: owner,
          sourceRepo: repo,
          sourceIssue: issue.number,
          params: validation.params
        }
      );

      await issueOps.createComment(context.octokit,{
        owner,
        repo,
        issue_number: issue.number,
        body: `✅ Request accepted. Provisioning \`${validation.params.name}\` (${validation.params.visibility}) — you'll get a confirmation comment when the repo is ready.`
      });
    } catch (err) {
      // Mark processed in finally even on error: the alternative is Probot
      // retrying after we've already created issues / posted comments,
      // which is exactly the duplicate-side-effect bug we're fixing.
      getLogger().error({ err, deliveryId }, 'issues.opened handler threw');
    } finally {
      if (deliveryId) markProcessed(deliveryId);
    }
  });

  app.on('issue_comment.created', async (context) => {
    if (!context.octokit) { return; }
    if (context.log) setLogger(context.log);
    const deliveryId = context.id;
    if (deliveryId && isProcessed(deliveryId)) {
      getLogger().info({ deliveryId }, 'Skipping duplicate webhook delivery');
      return;
    }

    const config = getConfig();
    const { comment, repository, sender } = context.payload;

    // Only check that the body is present. We previously also gated on
    // `context.octokit?.issues` being defined, but Probot v14 doesn't
    // *always* expose the `.issues` namespace — and silently skipping every
    // ChatOps command when it's missing is worse than letting individual
    // calls fail loudly (which they don't, in practice — `octokit.request()`
    // is always available and the existing call sites use it).
    if (!comment?.body || !context.octokit) {
      return;
    }

    const commandBody = comment.body.trim();
    const owner = repository.owner.login;
    const repo = repository.name;

    // ChatOps surface restriction: when enabled, slash commands are only
    // honoured in the designated admin repo. Comments from any other repo
    // are silently ignored — no log, no reply, no bot footprint in public
    // repos. The actual repo configuration changes still happen in their
    // target repos; this only restricts where the *triggers* can come from.
    const chatopsCfg = getChatopsRepoConfig();
    if (chatopsCfg?.enabled && chatopsCfg?.repo && commandBody.startsWith('/')) {
      const fullName = `${owner}/${repo}`;
      if (fullName !== chatopsCfg.repo) {
        if (deliveryId) markProcessed(deliveryId);
        return;
      }
    }
    const issueNumber = context.payload.issue.number;
    const senderLogin = sender.login;

    // Extract command from either /command or @botname command format
    let extractedCommand = commandBody;
    const botName = config?.bot_name || 'temper';
    const botMentionRegex = new RegExp(`^@${botName}\\[bot\\]\\s+(\\S+)`, 'i');
    const mentionMatch = commandBody.match(botMentionRegex);

    if (mentionMatch) {
      extractedCommand = '/' + mentionMatch[1];
    }

    // Check if user is allowed to run commands
    const allowedUsers = config?.allowed_command_users || [];
    const isAllowedUser = allowedUsers.length === 0 || allowedUsers.includes(senderLogin);

    const requireOrgMember = async () => {
      const isOrgMember = await checkOrganizationMembership(
        context.octokit,
        owner,
        senderLogin
      );
      if (!isOrgMember) {
        await issueOps.createComment(context.octokit,{
          owner,
          repo,
          issue_number: issueNumber,
          body: '❌ You must be an organization member to use this command.'
        });
        return false;
      }
      return true;
    };

    const requireAllowedUser = async () => {
      if (!isAllowedUser) {
        await issueOps.createComment(context.octokit,{
          owner,
          repo,
          issue_number: issueNumber,
          body: `❌ You are not authorized to use this command. Allowed users: ${allowedUsers.join(', ')}`
        });
        return false;
      }
      return true;
    };

    // Use extracted command (supports both /command and @botname command)
    getLogger().info({ commandBody, extractedCommand, botName }, "Debug: command parsing");
    const cmd = extractedCommand;

    if (cmd === '/configure-repo') {
      if (!(await requireOrgMember()) || !(await requireAllowedUser())) {
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      getLogger().info({ repo: repository.full_name }, 'Manual configuration requested');
      const result = await configureRepository(context.octokit, repository, undefined, {
        enqueueTask: getEnqueueTask()
      });

      await issueOps.createComment(context.octokit,{
        owner,
        repo,
        issue_number: issueNumber,
        body: result.success
          ? '✅ Repository configured with standard merge and branch protection settings!'
          : `❌ Configuration failed: ${result.error}`
      });
      if (deliveryId) markProcessed(deliveryId);
      return;
    }

    if (cmd === '/sync-all-repos') {
      if (!(await requireOrgMember()) || !(await requireAllowedUser())) {
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      const targetOrg = config?.organization || owner;
      const syncResult = await synchronizeAllRepositories(context.octokit, targetOrg);

      await issueOps.createComment(context.octokit,{
        owner,
        repo,
        issue_number: issueNumber,
        body: syncResult.success
          ? `✅ Synchronized all repositories! Processed ${syncResult.repositoriesProcessed} repositories.`
          : `❌ Synchronization failed: ${syncResult.error}`
      });
      if (deliveryId) markProcessed(deliveryId);
      return;
    }

    if (cmd === '/check-config') {
      if (!(await requireOrgMember()) || !(await requireAllowedUser())) {
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      const configReport = await generateConfigurationReport(context.octokit, owner, repo);
      await issueOps.createComment(context.octokit,{
        owner,
        repo,
        issue_number: issueNumber,
        body: configReport
      });
      if (deliveryId) markProcessed(deliveryId);
      return;
    }

    if (cmd === '/check-dependabot') {
      if (!(await requireOrgMember()) || !(await requireAllowedUser())) {
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      const dependabotReport = await checkDependabotConfiguration(context.octokit, owner, repo);
      await issueOps.createComment(context.octokit,{
        owner,
        repo,
        issue_number: issueNumber,
        body: dependabotReport
      });
      if (deliveryId) markProcessed(deliveryId);
      return;
    }

    if (cmd === '/fix-dependabot-labels') {
      if (!(await requireOrgMember()) || !(await requireAllowedUser())) {
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      const dependabotCheck = await checkExistingDependabotConfig(context.octokit, owner, repo);
      if (dependabotCheck.labelIssues.length > 0) {
        const fixResult = await fixDependabotPRLabels(
          context.octokit,
          owner,
          repo,
          dependabotCheck.labelIssues
        );

        await issueOps.createComment(context.octokit,{
          owner,
          repo,
          issue_number: issueNumber,
          body: `✅ Fixed labels on ${fixResult.fixedIssues} Dependabot PRs!`
        });
      } else {
        await issueOps.createComment(context.octokit,{
          owner,
          repo,
          issue_number: issueNumber,
          body: '✅ No Dependabot PR label issues found.'
        });
      }
      if (deliveryId) markProcessed(deliveryId);
      return;
    }

    if (cmd === '/generate-dependabot') {
      if (!(await requireOrgMember()) || !(await requireAllowedUser())) {
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      try {
        // Get default branch
        const repoData = await context.octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
        const defaultBranch = repoData.data.default_branch;

        const result = await generateDependabotConfig(context.octokit, owner, repo, defaultBranch);

        if (!result.config) {
          await issueOps.createComment(context.octokit,{
            owner, repo, issue_number: issueNumber,
            body: `No package ecosystems detected in ${owner}/${repo}. Nothing to generate.`
          });
        } else {
          const yaml = (await import('js-yaml')).default;
          let body = `## Generated Dependabot Configuration for ${owner}/${repo}\n\n`;
          body += `${result.report}\n\n`;
          body += '```yaml\n' + yaml.dump(result.config, { noRefs: true }) + '```\n\n';
          body += 'Applying configuration...';

          await issueOps.createComment(context.octokit,{
            owner, repo, issue_number: issueNumber,
            body
          });

          await applyDependabotConfig(context.octokit, owner, repo, result.config);

          await issueOps.createComment(context.octokit,{
            owner, repo, issue_number: issueNumber,
            body: '✅ Dependabot configuration applied!'
          });
        }
      } catch (error) {
        await issueOps.createComment(context.octokit,{
          owner, repo, issue_number: issueNumber,
          body: `❌ Error generating Dependabot config: ${error.message}`
        });
      }
      if (deliveryId) markProcessed(deliveryId);
      return;
    }

    if (cmd === '/analyze-org') {
      if (!(await requireOrgMember()) || !(await requireAllowedUser())) {
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      const org = config?.organization || owner;
      const analysisReport = await generateOrganizationAnalysisReport(context.octokit, org);

      const reportIssue = await issueOps.createIssue(context.octokit,{
        owner,
        repo,
        title: `Organization Analysis Report - ${new Date().toISOString().split('T')[0]}`,
        body: analysisReport,
        labels: ['analysis', 'report', 'automation']
      });

      await issueOps.createComment(context.octokit,{
        owner,
        repo,
        issue_number: issueNumber,
        body: `✅ Generated organization analysis report in issue #${reportIssue.data.number}`
      });
      if (deliveryId) markProcessed(deliveryId);
      return;
    }

    if (cmd === '/check-merge-strategy') {
      if (!(await requireOrgMember()) || !(await requireAllowedUser())) {
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      const strategyCheck = await checkPRMergeStrategy(
        context.octokit,
        owner,
        repo,
        issueNumber
      );
      if (strategyCheck.error) {
        await issueOps.createComment(context.octokit,{
          owner,
          repo,
          issue_number: issueNumber,
          body: `❌ Error checking merge strategy: ${strategyCheck.error}`
        });
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      let response = `## Merge Strategy Analysis for PR #${issueNumber}\n\n`;
      response += `**PR Title:** ${strategyCheck.prTitle}\n\n`;
      response += `**Base Branch:** ${strategyCheck.baseBranch}\n\n`;
      response += `**Commits:** ${strategyCheck.commitCount} total, ${strategyCheck.signedCommitCount} signed\n\n`;

      response += `### Current Repository Settings\n`;
      response += `- Allow Merge Commit: ${strategyCheck.currentMergeStrategy.allowMergeCommit ? '✅' : '❌'}\n`;
      response += `- Allow Squash Merge: ${strategyCheck.currentMergeStrategy.allowSquashMerge ? '✅' : '❌'}\n`;
      response += `- Allow Rebase Merge: ${strategyCheck.currentMergeStrategy.allowRebaseMerge ? '✅' : '❌'}\n\n`;

      if (strategyCheck.hasSignedCommits) {
        response += `⚠️  This PR contains signed commits!\n\n`;
        response += `💡 **Recommendation:** Use merge commit to preserve signatures.\n`;
        response += `Use cmd: /allow-merge-commit`;
      } else {
        response += `✅ No signed commits detected.\n\n`;
        response += `💡 **Recommendation:** Current merge strategy is appropriate.`;
      }

      await issueOps.createComment(context.octokit,{
        owner,
        repo,
        issue_number: issueNumber,
        body: response
      });
      if (deliveryId) markProcessed(deliveryId);
      return;
    }

    if (cmd === '/allow-merge-commit') {
      if (!(await requireOrgMember()) || !(await requireAllowedUser())) {
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      const allowedAdmins = config.signed_commit_strategy?.admin_users || [];
      if (allowedAdmins.length > 0 && !allowedAdmins.includes(sender.login)) {
        await issueOps.createComment(context.octokit,{
          owner,
          repo,
          issue_number: issueNumber,
          body: '❌ You are not authorized to run this command.'
        });
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      const result = await handleSignedCommitMerge(
        context.octokit,
        owner,
        repo,
        issueNumber,
        { enqueueTask: getEnqueueTask() }
      );
      if (result.success) {
        if (result.action === 'temporarily_allowed_merge_commits') {
          await issueOps.createComment(context.octokit,{
            owner,
            repo,
            issue_number: issueNumber,
            body:
              `✅ ${result.message}\n\n` +
              `You can now merge this PR using the merge commit strategy to preserve signed commits.\n\n` +
              `⚠️  Remember: Merge settings will restore to rebase-only after 1 hour.`
          });
        } else {
          await issueOps.createComment(context.octokit,{
            owner,
            repo,
            issue_number: issueNumber,
            body: `ℹ️  ${result.message}`
          });
        }
      } else {
        await issueOps.createComment(context.octokit,{
          owner,
          repo,
          issue_number: issueNumber,
          body: `❌ Error: ${result.error}`
        });
      }
      if (deliveryId) markProcessed(deliveryId);
      return;
    }

    if (cmd === '/review-pr') {
      if (!(await requireOrgMember()) || !(await requireAllowedUser())) {
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      // Verify the comment is on a PR (not a plain issue)
      if (!context.payload.issue.pull_request) {
        await issueOps.createComment(context.octokit,{
          owner,
          repo,
          issue_number: issueNumber,
          body: '❌ `/review-pr` can only be used on pull requests, not issues.'
        });
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      // Post a "working on it" indicator
      const workingComment = await issueOps.createComment(context.octokit,{
        owner,
        repo,
        issue_number: issueNumber,
        body: '🔍 AI review in progress...'
      });

      const result = await reviewPullRequest(context.octokit, owner, repo, issueNumber);

      if (!result.success) {
        await issueOps.updateComment(context.octokit,{
          owner,
          repo,
          comment_id: workingComment.data.id,
          body: `❌ AI review failed: ${result.error}`
        });
      } else {
        // Delete the "working" comment since the review was posted separately
        await issueOps.deleteComment(context.octokit,{
          owner,
          repo,
          comment_id: workingComment.data.id
        });
      }
      if (deliveryId) markProcessed(deliveryId);
      return;
    }
  });

  // PR opened: auto-merge for bots, AI review, dependabot generation check
  app.on('pull_request.opened', async (context) => {
    if (context.log) setLogger(context.log);
    const config = getConfig();
    const pr = context.payload.pull_request;
    const { repository } = context.payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    const sender = context.payload.sender?.login || "";

    // Auto-merge for Dependabot and bot PRs
    const autoMerge = config?.auto_merge;
    if (autoMerge?.enabled) {
      const isDependabot = sender === "dependabot[bot]" && autoMerge.on_dependabot;
      const isBotUser = (autoMerge.on_bot_users || []).some(
        bot => sender === bot || sender === bot + "[bot]"
      );

      if (isDependabot || isBotUser) {
        const mergeMethod = autoMerge.merge_method || "squash";
        getLogger().info({ pr: pr.number, sender, mergeMethod }, "Enabling auto-merge");

        try {
          const query = `mutation($prId: ID!, $mergeMethod: PullRequestMergeMethod!) {
            enablePullRequestAutoMerge(input: {
              pullRequestId: $prId,
              mergeMethod: $mergeMethod
            }) {
              pullRequest { number }
            }
          }`;

          await context.octokit.graphql(query, {
            prId: pr.node_id,
            mergeMethod: mergeMethod.toUpperCase()
          });

          getLogger().info({ pr: pr.number }, "Auto-merge enabled");
        } catch (err) {
          getLogger().warn({ pr: pr.number, err: err.message }, "Could not enable auto-merge");
        }
      }
    }

    // Auto AI review on new PRs (skip bot/dependabot PRs — they auto-merge
    // and the small model hallucinates on lockfile diffs)
    const isBotPR = sender === "dependabot[bot]" ||
      sender.endsWith("[bot]") ||
      (config?.auto_merge?.on_bot_users || []).some(
        bot => sender === bot || sender === bot + "[bot]"
      );

    if (config?.ai_review?.enabled && !isBotPR) {
      try {
        const result = await reviewPullRequest(context.octokit, owner, repo, pr.number);
        if (result.success) {
          getLogger().info({ pr: pr.number, repo: `${owner}/${repo}` }, 'Auto AI review posted');
        } else {
          getLogger().warn({ pr: pr.number, error: result.error }, 'Auto AI review skipped');
        }
      } catch (err) {
        getLogger().warn({ pr: pr.number, err: err.message }, 'Auto AI review failed');
      }
    }

    // Check dependabot config exists; enqueue generation if missing
    const genConfig = config?.dependabot_generation;
    if (genConfig?.enabled && _taskStore) {
      const key = `generate-dependabot:${owner}/${repo}`;

      try {
        await context.octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner,
          repo,
          path: '.github/dependabot.yml'
        });
      } catch (depErr) {
        if (depErr.status === 404) {
          _taskStore.enqueue('generate-dependabot', key, {
            owner,
            repo,
            defaultBranch: repository.default_branch
          });
          getLogger().info(
            { repo: `${owner}/${repo}` },
            'Enqueued dependabot generation (missing config detected on PR)'
          );
        }
      }
    }
  });

  app.on('pull_request.closed', async (context) => {
    if (context.log) setLogger(context.log);
    const deliveryId = context.id;
    if (deliveryId && isProcessed(deliveryId)) {
      getLogger().info({ deliveryId }, 'Skipping duplicate webhook delivery');
      return;
    }

    const { pull_request: pr, repository } = context.payload;
    const repo = `${repository.owner.login}/${repository.name}`;
    const status = pr.merged ? 'merged' : 'closed';

    const updated = updateReviewStatus(repo, pr.number, status);
    if (updated > 0) {
      getLogger().info({ repo, pr: pr.number, status }, `Marked ${updated} review(s) as ${status}`);
    }

    if (deliveryId) markProcessed(deliveryId);
  });

  app.on('push', async (context) => {
    if (context.log) setLogger(context.log);
    const deliveryId = context.id;
    if (deliveryId && isProcessed(deliveryId)) {
      getLogger().info({ deliveryId }, 'Skipping duplicate webhook delivery');
      return;
    }

    const config = getConfig();
    const selfUpdate = config?.self_update;
    if (!selfUpdate?.enabled) return;

    const { repository, ref } = context.payload;
    const expectedRef = `refs/heads/${selfUpdate.branch || 'main'}`;

    if (repository.name !== selfUpdate.repo || ref !== expectedRef) return;

    getLogger().info(
      { repo: repository.name, ref },
      'Push to own repo detected — triggering self-update'
    );

    triggerSelfUpdate(getLogger());

    if (deliveryId) markProcessed(deliveryId);
  });

  // Add health check endpoint with queue stats
  if (getRouter) {
    const router = getRouter('/');

    applySecurityMiddleware(router);

    router.get('/health', (req, res) => {
      const healthData = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: DEPLOY_SHA || '1.0.0',
        queue: defaultQueue.stats()
      };
      if (_taskStore) {
        healthData.tasks = _taskStore.getStats();
      }
      if (_scheduler) {
        healthData.scheduler = { running: _scheduler.isRunning() };
      }
      res.status(200).json(healthData);
    });

    router.get('/webhook', (req, res) => {
      res.status(200).json({
        message: 'Webhook endpoint ready',
        events: ['repository', 'issue_comment', 'pull_request', 'push']
      });
    });
  } else if (addHandler) {
    addHandler(createCustomRoutesHandler());
    addHandler(createDashboardHandler());
  }

  app.onError((error) => {
    getLogger().error({ err: error }, 'Probot error');
  });

  // Initialize persistence + scheduler unless caller opted out (e.g. tests).
  // Auto-skip in jest to avoid opening real SQLite files in unit tests.
  const inTest = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
  if (!options.skipPersistence && !inTest) {
    initPersistence();
    initScheduler(app);
  }
}

// Resolve the data directory. Created on first use.
function getDataDir() {
  const dir = path.join(__dirname, '..', 'data');
  return dir;
}

/**
 * Initialize SQLite-backed persistence for idempotency and AI rate limits,
 * replacing the in-memory Maps. Called once at app startup.
 */
function initPersistence() {
  try {
    const dataDir = getDataDir();
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

    const dedupStore = initKVStore(path.join(dataDir, 'dedup.db'), 'webhook_dedup', {
      ttlMs: 60 * 60 * 1000
    });
    setIdempotencyStore(dedupStore);

    const rateStore = initKVStore(path.join(dataDir, 'dedup.db'), 'ai_rate_limits', {
      ttlMs: 5 * 60 * 1000
    });
    setRateLimitStore(rateStore);

    getLogger().info('Persistent KV stores initialized (idempotency, ai_rate_limits)');
  } catch (err) {
    getLogger().warn({ err: err.message }, 'Failed to initialise persistent KV — falling back to in-memory');
  }
}

/**
 * Initialize the task store and scheduler. Probot installation tokens expire
 * after 1 hour, so the scheduler is given a factory that mints a fresh
 * installation-scoped Octokit per tick.
 *
 * @param {object} app - Probot app instance
 */
function initScheduler(app) {
  const config = getConfig();
  const schedulerConfig = config.scheduler || {};
  const targetOrg = config?.organization || process.env.ORGANIZATION;

  if (!targetOrg) {
    getLogger().warn('No target organization — scheduler not started');
    return null;
  }

  const dbPath = path.join(getDataDir(), 'tasks.db');
  _taskStore = initTaskStore(dbPath);

  // Per-tick factory: get app-level octokit, look up installation for the org,
  // mint installation-scoped octokit. Keeps installation tokens fresh.
  async function octokitFactory() {
    const appOctokit = await app.auth();
    const { data: installation } = await appOctokit.request(
      'GET /orgs/{org}/installation',
      { org: targetOrg }
    );
    return await app.auth(installation.id);
  }

  _scheduler = createScheduler(_taskStore, octokitFactory, {
    intervalMs: (schedulerConfig.interval_minutes || 5) * 60 * 1000,
    maxTasksPerTick: schedulerConfig.max_tasks_per_tick || 5,
    rateLimitThreshold: schedulerConfig.rate_limit_threshold || 100
  });

  _scheduler.registerHandler('generate-dependabot', async (payload, { octokit: kit, logger }) => {
    const { owner, repo, defaultBranch } = payload;
    logger.info(`Scheduler: generating dependabot config for ${owner}/${repo}`);

    const result = await generateDependabotConfig(kit, owner, repo, defaultBranch);
    if (result.config) {
      const labels = extractLabelsFromConfig(result.config);
      if (labels.length > 0) await ensureLabelsExist(kit, owner, repo, labels);
      await applyDependabotConfig(kit, owner, repo, result.config);
      logger.info(`Scheduler: applied dependabot config to ${owner}/${repo}`);
    } else {
      logger.info(`Scheduler: no ecosystems detected in ${owner}/${repo}, skipping`);
    }
  });

  _scheduler.registerHandler('revert-merge-settings', async (payload, { octokit: kit, logger }) => {
    const { owner, repo, allow_merge_commit } = payload;
    await kit.request('PATCH /repos/{owner}/{repo}', { owner, repo, allow_merge_commit });
    logger.info(`Scheduler: reverted merge settings on ${owner}/${repo} (allow_merge_commit=${allow_merge_commit})`);
  });

  _scheduler.registerHandler('reconcile-repo', async (payload, { octokit: kit, logger }) => {
    const { owner, repo } = payload;
    logger.info(`Scheduler: reconciling ${owner}/${repo}`);
    // Re-run full configuration. configureRepository is itself idempotent.
    const repoData = await kit.request('GET /repos/{owner}/{repo}', { owner, repo });
    const result = await configureRepository(kit, repoData.data, undefined, {
      enqueueTask: (type, key, p, opts) => _taskStore.enqueue(type, key, p, opts)
    });
    if (!result.success) {
      throw new Error(result.error || 'reconcile-repo failed');
    }
  });

  _scheduler.registerHandler('provision-repo', async (payload, ctx) => {
    await provisionRepo(payload, ctx);
  });

  _scheduler.start();
  getLogger().info('Task store and scheduler initialized');

  return { store: _taskStore, scheduler: _scheduler };
}

/**
 * Fail fast at startup when WEBHOOK_SECRET is unset, empty, or equals the
 * literal string "development".
 *
 * Without this, Probot defaults the webhook secret to "development" when the
 * env var is missing — silently accepting forged webhooks signed with that
 * trivially-known string. The wave-1 security auditor flagged this as the
 * single highest-impact trust-boundary fail-open in the bot. (Bug #2 in
 * docs/agent-fleet/bugs.md.)
 *
 * Exported so it can be unit-tested without booting Probot. Throws Error so
 * the caller's existing try/catch in index.js produces the standard
 * "Error starting Probot:" message.
 *
 * Call this AFTER mapLegacyEnvVars so legacy GITHUB_WEBHOOK_SECRET → WEBHOOK_SECRET
 * mapping is honoured before validation.
 */
function assertWebhookSecret(env = process.env) {
  const secret = env.WEBHOOK_SECRET;
  if (!secret || secret.trim() === '') {
    throw new Error(
      'WEBHOOK_SECRET environment variable is required. ' +
      'Without it Probot defaults to the literal string "development", ' +
      'silently accepting forged webhooks. Set it in .env or via your ' +
      'process supervisor.'
    );
  }
  if (secret === 'development') {
    throw new Error(
      'WEBHOOK_SECRET cannot equal the literal string "development" — ' +
      'that is Probot\'s fail-open default. Set a real secret (e.g. ' +
      '`openssl rand -hex 32`).'
    );
  }
}

function mapLegacyEnvVars() {
  if (process.env.GITHUB_APP_ID && !process.env.APP_ID) {
    process.env.APP_ID = process.env.GITHUB_APP_ID;
  }
  if (process.env.GITHUB_PRIVATE_KEY && !process.env.PRIVATE_KEY) {
    process.env.PRIVATE_KEY = process.env.GITHUB_PRIVATE_KEY;
  }
  if (process.env.GITHUB_WEBHOOK_SECRET && !process.env.WEBHOOK_SECRET) {
    process.env.WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;
  }
  if (!process.env.WEBHOOK_PATH) {
    process.env.WEBHOOK_PATH = '/api/github/webhooks';
  }
}

export {
  registerApp,
  mapLegacyEnvVars,
  assertWebhookSecret,
  createCustomRoutesHandler,
  applySecurityHeaders,
  initScheduler,
  getTaskStore,
  getScheduler
};
