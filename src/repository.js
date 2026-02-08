'use strict';

const { normalizeRepoInput, getDefaultBranch } = require('./helpers');
const {
  getConfig,
  getMergeSettings,
  getBranchProtectionConfig,
  mergePullRequestRules,
  getTargetIssueLabels
} = require('./config');
const { applyBranchProtection } = require('./branch-protection');
const { applyTemplates, applyCodeowners } = require('./templates');
const { synchronizeIssueLabels } = require('./labels');
const {
  applyDependabotConfig,
  checkExistingDependabotConfig,
  fixDependabotPRLabels
} = require('./dependabot');

async function configureRepository(octokit, repoOrOwner, maybeRepo) {
  const config = getConfig();
  const repoInfo = normalizeRepoInput(repoOrOwner, maybeRepo);
  const owner = repoInfo.owner.login;
  const repo = repoInfo.name;
  const defaultBranch = getDefaultBranch(repoInfo);

  try {
    console.log(`Configuring repository: ${owner}/${repo}`);

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

    if (config?.dependabot) {
      const dependabotCheck = await checkExistingDependabotConfig(octokit, owner, repo);

      if (dependabotCheck.labelIssues.length > 0) {
        await fixDependabotPRLabels(octokit, owner, repo, dependabotCheck.labelIssues);
      }

      if (!dependabotCheck.exists || !dependabotCheck.matchesTarget) {
        await applyDependabotConfig(octokit, owner, repo, config.dependabot);
      }
    }

    console.log(`✅ Successfully configured ${owner}/${repo}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error configuring ${owner}/${repo}:`, error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  configureRepository
};
