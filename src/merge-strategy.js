import { getConfig } from './config.js';
import { getLogger } from './logger.js';

async function handleSignedCommitMerge(octokit, owner, repo, prNumber, { enqueueTask } = {}) {
  const config = getConfig();

  try {
    getLogger().info(`Handling signed commit merge for ${owner}/${repo} PR #${prNumber}`);

    if (!config.signed_commit_strategy?.allow_merge_commits_for_signed) {
      return {
        success: true,
        action: 'disabled',
        message: 'Signed-commit merge override is disabled by configuration.'
      };
    }

    const prDetails = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber
    });

    const prCommits = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits',
      { owner, repo, pull_number: prNumber }
    );

    const hasSignedCommits = prCommits.data.some(
      (commit) => commit.commit.verification && commit.commit.verification.verified
    );

    const baseBranch = prDetails.data.base.ref;
    const protectedBranches = config.signed_commit_strategy?.protected_branches || [];
    if (protectedBranches.length > 0 && !protectedBranches.includes(baseBranch)) {
      return {
        success: true,
        action: 'not_applicable',
        message: `Branch ${baseBranch} is not configured for signed-commit merge overrides.`
      };
    }

    if (hasSignedCommits) {
      getLogger().info(`✅ PR #${prNumber} contains signed commits`);

      const repoSettings = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });

      const allowsMergeCommits = repoSettings.data.allow_merge_commit;
      const originalAllowMergeCommits = repoSettings.data.allow_merge_commit;

      if (!allowsMergeCommits) {
        getLogger().info('⚠️  Merge commits are disabled, temporarily allowing...');

        await octokit.request('PATCH /repos/{owner}/{repo}', {
          owner,
          repo,
          allow_merge_commit: true
        });

        getLogger().info('✅ Temporarily allowed merge commits for signed commit preservation');

        const timeoutMs = config.signed_commit_strategy?.temporary_rule_timeout || 3600000;

        if (enqueueTask) {
          // Persistent revert: survives process restart, unlike setTimeout.
          enqueueTask(
            'revert-merge-settings',
            `revert-merge-settings:${owner}/${repo}:${prNumber}`,
            { owner, repo, allow_merge_commit: originalAllowMergeCommits },
            { delayMs: timeoutMs }
          );
        } else {
          // Best-effort fallback when no task store is wired (tests, dev).
          setTimeout(async () => {
            try {
              await octokit.request('PATCH /repos/{owner}/{repo}', {
                owner,
                repo,
                allow_merge_commit: originalAllowMergeCommits
              });
              getLogger().info('⏳ Re-enabled rebase-only merge after timeout');
            } catch (error) {
              getLogger().error('❌ Failed to restore merge settings:', error.message);
            }
          }, timeoutMs);
        }

        return {
          success: true,
          action: 'temporarily_allowed_merge_commits',
          message:
            'Repository merge settings temporarily modified to allow merge commits for signed commit preservation. Will restore rebase-only after 1 hour.'
        };
      } else {
        return {
          success: true,
          action: 'no_change_needed',
          message: 'Branch already allows merge commits, no changes needed.'
        };
      }
    } else {
      getLogger().info(`ℹ️  PR #${prNumber} has no signed commits, using normal merge strategy`);
      return {
        success: true,
        action: 'no_signed_commits',
        message: 'No signed commits detected, proceeding with normal merge strategy.'
      };
    }
  } catch (error) {
    getLogger().error(
      `❌ Error handling signed commit merge for ${owner}/${repo} PR #${prNumber}:`,
      error.message
    );
    return {
      success: false,
      error: error.message
    };
  }
}

async function checkPRMergeStrategy(octokit, owner, repo, prNumber) {
  try {
    getLogger().info(`Checking merge strategy for ${owner}/${repo} PR #${prNumber}`);

    const prDetails = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber
    });

    const repoSettings = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });

    const commits = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/commits',
      { owner, repo, pull_number: prNumber }
    );

    const hasSignedCommits = commits.data.some(
      (commit) => commit.commit.verification && commit.commit.verification.verified
    );

    return {
      prTitle: prDetails.data.title,
      baseBranch: prDetails.data.base.ref,
      hasSignedCommits,
      currentMergeStrategy: {
        allowMergeCommit: repoSettings.data.allow_merge_commit,
        allowSquashMerge: repoSettings.data.allow_squash_merge,
        allowRebaseMerge: repoSettings.data.allow_rebase_merge
      },
      commitCount: commits.data.length,
      signedCommitCount: commits.data.filter((c) => c.commit.verification?.verified).length
    };
  } catch (error) {
    getLogger().error(`❌ Error checking PR merge strategy:`, error.message);
    return {
      error: error.message
    };
  }
}

export {
  handleSignedCommitMerge,
  checkPRMergeStrategy
};
