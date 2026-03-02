import { normalizeRepoInput, getDefaultBranch } from './helpers.js';
import { getLogger } from './logger.js';
import {
  getConfig,
  getMergeSettings,
  getBranchProtectionConfig,
  mergePullRequestRules,
  getTargetIssueLabels
} from './config.js';
import { applyBranchProtection } from './branch-protection.js';
import { applyTemplates, applyCodeowners } from './templates.js';
import { synchronizeIssueLabels } from './labels.js';
import {
  applyDependabotConfig,
  checkExistingDependabotConfig,
  fixDependabotPRLabels
} from './dependabot.js';

async function configureRepository(octokit, repoOrOwner, maybeRepo, { enqueueTask } = {}) {
  const config = getConfig();
  const repoInfo = normalizeRepoInput(repoOrOwner, maybeRepo);
  const owner = repoInfo.owner.login;
  const repo = repoInfo.name;
  const defaultBranch = getDefaultBranch(repoInfo);

  try {
    getLogger().info(`Configuring repository: ${owner}/${repo}`);

    const mergeSettings = getMergeSettings(repoInfo);
    await octokit.request('PATCH /repos/{owner}/{repo}', {
      owner,
      repo,
      ...mergeSettings
    });

    if (config?.branch_protection) {
      const protectionConfig = mergePullRequestRules(
        getBranchProtectionConfig(repoInfo) || {}
      );
      await applyBranchProtection(octokit, owner, repo, defaultBranch, protectionConfig);
    }

    const targetLabels = getTargetIssueLabels();
    if (targetLabels.length > 0) {
      await synchronizeIssueLabels(octokit, owner, repo, targetLabels);
    }

    if (config?.templates) {
      await applyTemplates(octokit, owner, repo, config.templates);
    }

    if (config?.codeowners) {
      await applyCodeowners(octokit, owner, repo, config.codeowners);
    }

    if (config?.dependabot_generation?.enabled) {
      const dependabotCheck = await checkExistingDependabotConfig(octokit, owner, repo);

      if (dependabotCheck.labelIssues.length > 0) {
        await fixDependabotPRLabels(octokit, owner, repo, dependabotCheck.labelIssues);
      }

      if (!dependabotCheck.exists) {
        // Enqueue for async generation rather than blocking the webhook
        if (enqueueTask) {
          enqueueTask(
            'generate-dependabot',
            `generate-dependabot:${owner}/${repo}`,
            { owner, repo, defaultBranch }
          );
          getLogger().info(`Enqueued dependabot generation for ${owner}/${repo}`);
        }
      }
    } else if (config?.dependabot) {
      const dependabotCheck = await checkExistingDependabotConfig(octokit, owner, repo);

      if (dependabotCheck.labelIssues.length > 0) {
        await fixDependabotPRLabels(octokit, owner, repo, dependabotCheck.labelIssues);
      }

      if (!dependabotCheck.exists || !dependabotCheck.matchesTarget) {
        await applyDependabotConfig(octokit, owner, repo, config.dependabot);
      }
    }

    getLogger().info(`✅ Successfully configured ${owner}/${repo}`);
    return { success: true };
  } catch (error) {
    getLogger().error(`❌ Error configuring ${owner}/${repo}:`, error.message);
    return { success: false, error: error.message };
  }
}

export {
  configureRepository
};
