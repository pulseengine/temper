import path from 'path';
import { fileURLToPath } from 'url';
import { createDashboardHandler, DEPLOY_SHA } from './dashboard.js';
import { getConfig } from './config.js';
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
import { reviewPullRequest, updateReviewStatus } from './ai-review.js';
import { isProcessed, markProcessed } from './idempotency.js';
import { triggerSelfUpdate } from './self-update.js';
import { defaultQueue } from './queue.js';
import { applySecurityMiddleware } from './middleware.js';
import { initTaskStore } from './task-store.js';
import { createScheduler } from './scheduler.js';

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

function registerApp(app, { getRouter, addHandler } = {}) {
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

      // Wait for the default branch to exist before configuring.
      // When GitHub fires repository.created, the repo exists but the default
      // branch is only created after the first commit.
      const defaultBranch = repository.default_branch || 'main';
      const owner = repository.owner.login;
      const repoName = repository.name;
      let branchReady = false;

      for (let attempt = 1; attempt <= 5; attempt++) {
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
            getLogger().info(
              { repo: repository.full_name, branch: defaultBranch, attempt },
              `Default branch not ready yet, retrying in 2s (attempt ${attempt}/5)`
            );
            await new Promise(resolve => setTimeout(resolve, 2000));
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
        getLogger().warn(
          { repo: repository.full_name, branch: defaultBranch },
          'Default branch never appeared — repo may still be empty. Skipping configuration.'
        );
        if (deliveryId) markProcessed(deliveryId);
        return;
      }

      const result = await configureRepository(context.octokit, repository, undefined, {
        enqueueTask: getEnqueueTask()
      });

      if (repository.has_issues) {
        try {
          await context.octokit.issues.create({
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

    if (!comment?.body || !context.octokit?.issues) {
      return;
    }

    const commandBody = comment.body.trim();
    const owner = repository.owner.login;
    const repo = repository.name;
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
        await context.octokit.issues.createComment({
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
        await context.octokit.issues.createComment({
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
        return;
      }

      getLogger().info({ repo: repository.full_name }, 'Manual configuration requested');
      const result = await configureRepository(context.octokit, repository, undefined, {
        enqueueTask: getEnqueueTask()
      });

      await context.octokit.issues.createComment({
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
        return;
      }

      const targetOrg = config?.organization || owner;
      const syncResult = await synchronizeAllRepositories(context.octokit, targetOrg);

      await context.octokit.issues.createComment({
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
        return;
      }

      const configReport = await generateConfigurationReport(context.octokit, owner, repo);
      await context.octokit.issues.createComment({
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
        return;
      }

      const dependabotReport = await checkDependabotConfiguration(context.octokit, owner, repo);
      await context.octokit.issues.createComment({
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

        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: issueNumber,
          body: `✅ Fixed labels on ${fixResult.fixedIssues} Dependabot PRs!`
        });
      } else {
        await context.octokit.issues.createComment({
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
        return;
      }

      try {
        // Get default branch
        const repoData = await context.octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
        const defaultBranch = repoData.data.default_branch;

        const result = await generateDependabotConfig(context.octokit, owner, repo, defaultBranch);

        if (!result.config) {
          await context.octokit.issues.createComment({
            owner, repo, issue_number: issueNumber,
            body: `No package ecosystems detected in ${owner}/${repo}. Nothing to generate.`
          });
        } else {
          const yaml = (await import('js-yaml')).default;
          let body = `## Generated Dependabot Configuration for ${owner}/${repo}\n\n`;
          body += `${result.report}\n\n`;
          body += '```yaml\n' + yaml.dump(result.config) + '```\n\n';
          body += 'Applying configuration...';

          await context.octokit.issues.createComment({
            owner, repo, issue_number: issueNumber,
            body
          });

          await applyDependabotConfig(context.octokit, owner, repo, result.config);

          await context.octokit.issues.createComment({
            owner, repo, issue_number: issueNumber,
            body: '✅ Dependabot configuration applied!'
          });
        }
      } catch (error) {
        await context.octokit.issues.createComment({
          owner, repo, issue_number: issueNumber,
          body: `❌ Error generating Dependabot config: ${error.message}`
        });
      }
      if (deliveryId) markProcessed(deliveryId);
      return;
    }

    if (cmd === '/analyze-org') {
      if (!(await requireOrgMember()) || !(await requireAllowedUser())) {
        return;
      }

      const org = config?.organization || owner;
      const analysisReport = await generateOrganizationAnalysisReport(context.octokit, org);

      const reportIssue = await context.octokit.issues.create({
        owner,
        repo,
        title: `Organization Analysis Report - ${new Date().toISOString().split('T')[0]}`,
        body: analysisReport,
        labels: ['analysis', 'report', 'automation']
      });

      await context.octokit.issues.createComment({
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
        return;
      }

      const strategyCheck = await checkPRMergeStrategy(
        context.octokit,
        owner,
        repo,
        issueNumber
      );
      if (strategyCheck.error) {
        await context.octokit.issues.createComment({
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

      await context.octokit.issues.createComment({
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
        return;
      }

      const allowedAdmins = config.signed_commit_strategy?.admin_users || [];
      if (allowedAdmins.length > 0 && !allowedAdmins.includes(sender.login)) {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: issueNumber,
          body: '❌ You are not authorized to run this command.'
        });
        return;
      }

      const result = await handleSignedCommitMerge(context.octokit, owner, repo, issueNumber);
      if (result.success) {
        if (result.action === 'temporarily_allowed_merge_commits') {
          await context.octokit.issues.createComment({
            owner,
            repo,
            issue_number: issueNumber,
            body:
              `✅ ${result.message}\n\n` +
              `You can now merge this PR using the merge commit strategy to preserve signed commits.\n\n` +
              `⚠️  Remember: Merge settings will restore to rebase-only after 1 hour.`
          });
        } else {
          await context.octokit.issues.createComment({
            owner,
            repo,
            issue_number: issueNumber,
            body: `ℹ️  ${result.message}`
          });
        }
      } else {
        await context.octokit.issues.createComment({
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
        return;
      }

      // Verify the comment is on a PR (not a plain issue)
      if (!context.payload.issue.pull_request) {
        await context.octokit.issues.createComment({
          owner,
          repo,
          issue_number: issueNumber,
          body: '❌ `/review-pr` can only be used on pull requests, not issues.'
        });
        return;
      }

      // Post a "working on it" indicator
      const workingComment = await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body: '🔍 AI review in progress...'
      });

      const result = await reviewPullRequest(context.octokit, owner, repo, issueNumber);

      if (!result.success) {
        await context.octokit.issues.updateComment({
          owner,
          repo,
          comment_id: workingComment.data.id,
          body: `❌ AI review failed: ${result.error}`
        });
      } else {
        // Delete the "working" comment since the review was posted separately
        await context.octokit.issues.deleteComment({
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
}

/**
 * Initialize the task store and scheduler.
 * Call this once at startup with an authenticated octokit instance.
 */
function initScheduler(octokit) {
  const config = getConfig();
  const schedulerConfig = config.scheduler || {};

  const dbPath = path.join(__dirname, '..', 'data', 'tasks.db');
  _taskStore = initTaskStore(dbPath);

  _scheduler = createScheduler(_taskStore, octokit, {
    intervalMs: (schedulerConfig.interval_minutes || 5) * 60 * 1000,
    maxTasksPerTick: schedulerConfig.max_tasks_per_tick || 5,
    rateLimitThreshold: schedulerConfig.rate_limit_threshold || 100
  });

  // Register the generate-dependabot handler
  _scheduler.registerHandler('generate-dependabot', async (payload, { octokit: kit, logger }) => {
    const { owner, repo, defaultBranch } = payload;
    logger.info(`Scheduler: generating dependabot config for ${owner}/${repo}`);

    const result = await generateDependabotConfig(kit, owner, repo, defaultBranch);
    if (result.config) {
      const labels = extractLabelsFromConfig(result.config);
      if (labels.length > 0) {
        await ensureLabelsExist(kit, owner, repo, labels);
      }
      await applyDependabotConfig(kit, owner, repo, result.config);
      logger.info(`Scheduler: applied dependabot config to ${owner}/${repo}`);
    } else {
      logger.info(`Scheduler: no ecosystems detected in ${owner}/${repo}, skipping`);
    }
  });

  _scheduler.start();
  getLogger().info('Task store and scheduler initialized');

  return { store: _taskStore, scheduler: _scheduler };
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
  createCustomRoutesHandler,
  applySecurityHeaders,
  initScheduler,
  getTaskStore,
  getScheduler
};
