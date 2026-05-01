import { normalizeRepoInput, getDefaultBranch } from './helpers.js';
import { getLogger } from './logger.js';
import {
  getConfig,
  getMergeSettings,
  getBranchProtectionConfig,
  mergePullRequestRules,
  getTargetIssueLabels,
  getRulesetConfig,
  isControlSurfaceRepo
} from './config.js';
import { applyBranchProtection } from './branch-protection.js';
import { applyRulesetFromBranchProtection } from './rulesets.js';
import { applyTemplates, applyCodeowners } from './templates.js';
import { synchronizeIssueLabels } from './labels.js';
import {
  applyDependabotConfig,
  checkExistingDependabotConfig,
  fixDependabotPRLabels
} from './dependabot.js';

/**
 * Apply branch-level enforcement (rulesets when enabled, legacy branch protection
 * otherwise). Rulesets work on empty repos; legacy does not — that's the whole
 * point of preferring rulesets when available.
 */
async function applyBranchEnforcement(octokit, owner, repo, defaultBranch, protectionConfig) {
  const rulesetCfg = getRulesetConfig();

  if (rulesetCfg?.enabled) {
    try {
      const result = await applyRulesetFromBranchProtection(
        octokit,
        owner,
        repo,
        protectionConfig,
        { name: rulesetCfg.name }
      );
      getLogger().info(
        { action: result.action, id: result.id },
        `Ruleset applied to ${owner}/${repo}`
      );
      return { mode: 'ruleset', ...result };
    } catch (err) {
      const status = err.status || err.statusCode;
      if (rulesetCfg.fall_back_to_legacy && (status === 404 || status === 422 || status === 403)) {
        getLogger().warn(
          { status, err: err.message },
          `Rulesets not available for ${owner}/${repo}, falling back to legacy branch protection`
        );
      } else {
        throw err;
      }
    }
  }

  await applyBranchProtection(octokit, owner, repo, defaultBranch, protectionConfig);
  return { mode: 'legacy' };
}

/**
 * Configure a repo to org standards.
 *
 * @param {object} octokit
 * @param {string|object} repoOrOwner
 * @param {string} [maybeRepo]
 * @param {object} [opts]
 * @param {Function} [opts.enqueueTask] - persistent task enqueue
 * @param {boolean} [opts.skipBranchScopedWork=false] - skip operations that require
 *   the default branch to exist (templates, codeowners, dependabot, labels via
 *   commits). Set true when configuring an empty repo.
 */
async function configureRepository(
  octokit,
  repoOrOwner,
  maybeRepo,
  { enqueueTask, skipBranchScopedWork = false } = {}
) {
  const config = getConfig();
  const repoInfo = normalizeRepoInput(repoOrOwner, maybeRepo);
  const owner = repoInfo.owner.login;
  const repo = repoInfo.name;
  const fullName = `${owner}/${repo}`;
  const defaultBranch = getDefaultBranch(repoInfo);

  if (isControlSurfaceRepo(fullName)) {
    getLogger().info(
      { repo: fullName },
      'Skipping configuration: control-surface repo (chatops_repo / controller_repo)'
    );
    return { success: true, skipped: 'control-surface' };
  }

  try {
    getLogger().info(`Configuring repository: ${owner}/${repo} (skipBranchScopedWork=${skipBranchScopedWork})`);

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
      await applyBranchEnforcement(octokit, owner, repo, defaultBranch, protectionConfig);
    }

    const targetLabels = getTargetIssueLabels();
    if (targetLabels.length > 0) {
      // Labels don't need a default branch — safe even on empty repos.
      // Default sync mode is 'merge' (non-destructive). Set
      // `issue_labels_sync_mode: replace` in config.yml to opt back into the
      // pre-Bug-#1 behaviour that deletes labels not in the target list.
      const labelSyncMode = config?.issue_labels_sync_mode || 'merge';
      await synchronizeIssueLabels(octokit, owner, repo, targetLabels, {
        mode: labelSyncMode
      });
    }

    if (skipBranchScopedWork) {
      // The repo has no default branch yet. Rulesets, merge settings and labels
      // are already applied above. Defer the rest to a follow-up task once the
      // first push lands.
      if (enqueueTask) {
        enqueueTask(
          'reconcile-repo',
          `reconcile-repo:${owner}/${repo}`,
          { owner, repo },
          { delayMs: 60000 }
        );
        getLogger().info(`Enqueued reconcile-repo for ${owner}/${repo} (empty repo deferred work)`);
      }
      getLogger().info(`✅ Partial config applied to empty repo ${owner}/${repo}`);
      return { success: true, partial: true };
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
