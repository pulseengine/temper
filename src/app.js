import { createDashboardHandler } from './dashboard.js';
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
  fixDependabotPRLabels
} from './dependabot.js';
import { handleSignedCommitMerge, checkPRMergeStrategy } from './merge-strategy.js';
import { reviewPullRequest, updateReviewStatus } from './ai-review.js';
import { isProcessed, markProcessed } from './idempotency.js';
import { defaultQueue } from './queue.js';
import { applySecurityMiddleware } from './middleware.js';

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
      const body = JSON.stringify({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        queue: defaultQueue.stats()
      });
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

      const result = await configureRepository(context.octokit, repository);

      if (repository.has_issues) {
        await context.octokit.issues.create({
          owner: repository.owner.login,
          repo: repository.name,
          title: 'Repository Configuration',
          body: result.success
            ? '✅ This repository has been automatically configured with standard merge settings and branch protection.'
            : `❌ Configuration failed: ${result.error}`,
          labels: ['automation', 'configuration']
        });
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
      const result = await configureRepository(context.octokit, repository);

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

  // Auto-merge for Dependabot and bot PRs
  app.on('pull_request.opened', async (context) => {
    if (context.log) setLogger(context.log);
    const config = getConfig();
    const autoMerge = config?.auto_merge;
    if (!autoMerge?.enabled) return;

    const pr = context.payload.pull_request;
    const sender = context.payload.sender?.login || "";
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;

    const isDependabot = sender === "dependabot[bot]" && autoMerge.on_dependabot;
    const isBotUser = (autoMerge.on_bot_users || []).some(
      bot => sender === bot || sender === bot + "[bot]"
    );

    if (!isDependabot && !isBotUser) return;

    const mergeMethod = autoMerge.merge_method || "squash";
    getLogger().info({ pr: pr.number, sender, mergeMethod }, "Enabling auto-merge");

    try {
      // GitHub GraphQL is needed for enablePullRequestAutoMerge
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

  // Add health check endpoint with queue stats
  if (getRouter) {
    const router = getRouter('/');

    applySecurityMiddleware(router);

    router.get('/health', (req, res) => {
      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        queue: defaultQueue.stats()
      });
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
  applySecurityHeaders
};
