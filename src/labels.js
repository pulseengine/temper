import { getLogger } from './logger.js';
import { DEPENDABOT_LABEL_DEFAULTS } from './config.js';

async function ensureLabelsExist(octokit, owner, repo, labelNames) {
  const currentLabels = await octokit.paginate('GET /repos/{owner}/{repo}/labels', {
    owner,
    repo,
    per_page: 100
  });
  const existingNames = new Set(currentLabels.map((l) => l.name));

  for (const name of labelNames) {
    if (!existingNames.has(name)) {
      const defaults = DEPENDABOT_LABEL_DEFAULTS[name] || {
        color: 'ededed',
        description: 'Automated label'
      };
      await octokit.request('POST /repos/{owner}/{repo}/labels', {
        owner,
        repo,
        name,
        color: defaults.color,
        description: defaults.description
      });
      getLogger().info(`Created label: ${name}`);
    }
  }
}

const VALID_SYNC_MODES = new Set(['merge', 'replace']);

/**
 * Synchronize a repo's issue labels with `targetLabels`.
 *
 * @param {object} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {Array<{name: string, color: string, description?: string}>} targetLabels
 * @param {object} [options]
 * @param {'merge'|'replace'} [options.mode='merge'] - synchronization mode:
 *   - `'merge'` (default): only create / update labels listed in `targetLabels`.
 *     Labels not in the target list are left untouched. Non-destructive.
 *   - `'replace'`: in addition to create/update, deletes any label that is not
 *     in the target list. Destructive — the historical (pre-Bug #1) behaviour,
 *     preserved as opt-in.
 */
async function synchronizeIssueLabels(octokit, owner, repo, targetLabels, options = {}) {
  const mode = options.mode || 'merge';
  if (!VALID_SYNC_MODES.has(mode)) {
    throw new Error(
      `synchronizeIssueLabels: invalid mode "${mode}" (expected "merge" or "replace")`
    );
  }

  try {
    getLogger().info(`Synchronizing labels for ${owner}/${repo} (mode=${mode})`);

    const currentLabels = await octokit.paginate('GET /repos/{owner}/{repo}/labels', {
      owner,
      repo,
      per_page: 100
    });

    for (const targetLabel of targetLabels) {
      const existingLabel = currentLabels.find((l) => l.name === targetLabel.name);

      if (existingLabel) {
        if (
          existingLabel.color !== targetLabel.color ||
          existingLabel.description !== targetLabel.description
        ) {
          await octokit.request('PATCH /repos/{owner}/{repo}/labels/{name}', {
            owner,
            repo,
            name: targetLabel.name,
            color: targetLabel.color,
            description: targetLabel.description
          });
          getLogger().info(`Updated label: ${targetLabel.name}`);
        }
      } else {
        await octokit.request('POST /repos/{owner}/{repo}/labels', {
          owner,
          repo,
          name: targetLabel.name,
          color: targetLabel.color,
          description: targetLabel.description
        });
        getLogger().info(`Created label: ${targetLabel.name}`);
      }
    }

    if (mode === 'replace') {
      for (const currentLabel of currentLabels) {
        if (!targetLabels.some((tl) => tl.name === currentLabel.name)) {
          await octokit.request('DELETE /repos/{owner}/{repo}/labels/{name}', {
            owner,
            repo,
            name: currentLabel.name
          });
          getLogger().info(`Removed label: ${currentLabel.name}`);
        }
      }
    }

    getLogger().info(`✅ Synchronized labels for ${owner}/${repo}`);
  } catch (error) {
    getLogger().error(`❌ Error synchronizing labels for ${owner}/${repo}:`, error.message);
    throw error;
  }
}

export {
  ensureLabelsExist,
  synchronizeIssueLabels
};
