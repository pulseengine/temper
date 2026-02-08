'use strict';

const { getConfig } = require('./config');
const { configureRepository } = require('./repository');
const {
  checkOrganizationMembership,
  synchronizeAllRepositories,
  generateOrganizationAnalysisReport
} = require('./organization');
const { generateConfigurationReport } = require('./reporting');
const {
  checkDependabotConfiguration,
  checkExistingDependabotConfig,
  fixDependabotPRLabels
} = require('./dependabot');
const { handleSignedCommitMerge, checkPRMergeStrategy } = require('./merge-strategy');
const { reviewPullRequest } = require('./ai-review');

function registerApp(app, { getRouter } = {}) {
  app.on('repository.created', async (context) => {
    const config = getConfig();
    const { repository, organization } = context.payload;

    const targetOrg = config?.organization || process.env.ORGANIZATION || 'pulseengine';
    const repoOrg = organization?.login || repository.owner?.login;

    if (repoOrg === targetOrg) {
      console.log(`New repository created: ${repository.full_name}`);

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
  });

  app.on('issue_comment.created', async (context) => {
    const config = getConfig();
    const { comment, repository, sender } = context.payload;
    if (!comment?.body) {
      return;
    }

    const command = comment.body.trim();
    const owner = repository.owner.login;
    const repo = repository.name;
    const issueNumber = context.payload.issue.number;

    const requireOrgMember = async () => {
      const isOrgMember = await checkOrganizationMembership(
        context.octokit,
        owner,
        sender.login
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

    if (command === '/configure-repo') {
      if (!(await requireOrgMember())) {
        return;
      }

      console.log(`Manual configuration requested for: ${repository.full_name}`);
      const result = await configureRepository(context.octokit, repository);

      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body: result.success
          ? '✅ Repository configured with standard merge and branch protection settings!'
          : `❌ Configuration failed: ${result.error}`
      });
      return;
    }

    if (command === '/sync-all-repos') {
      if (!(await requireOrgMember())) {
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
      return;
    }

    if (command === '/check-config') {
      if (!(await requireOrgMember())) {
        return;
      }

      const configReport = await generateConfigurationReport(context.octokit, owner, repo);
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body: configReport
      });
      return;
    }

    if (command === '/check-dependabot') {
      if (!(await requireOrgMember())) {
        return;
      }

      const dependabotReport = await checkDependabotConfiguration(context.octokit, owner, repo);
      await context.octokit.issues.createComment({
        owner,
        repo,
        issue_number: issueNumber,
        body: dependabotReport
      });
      return;
    }

    if (command === '/fix-dependabot-labels') {
      if (!(await requireOrgMember())) {
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
      return;
    }

    if (command === '/analyze-org') {
      if (!(await requireOrgMember())) {
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
      return;
    }

    if (command === '/check-merge-strategy') {
      if (!(await requireOrgMember())) {
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
        response += `Use command: /allow-merge-commit`;
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
      return;
    }

    if (command === '/allow-merge-commit') {
      if (!(await requireOrgMember())) {
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
      return;
    }

    if (command === '/review-pr') {
      if (!(await requireOrgMember())) {
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
      return;
    }
  });

  // Add health check endpoint
  if (getRouter) {
    const router = getRouter('/');
    router.get('/health', (req, res) => {
      res.status(200).json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      });
    });

    router.get('/webhook', (req, res) => {
      res.status(200).json({
        message: 'Webhook endpoint ready',
        events: ['repository', 'issue_comment', 'pull_request', 'push']
      });
    });
  }

  app.onError((error) => {
    console.error('Probot error:', error);
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

module.exports = {
  registerApp,
  mapLegacyEnvVars
};
