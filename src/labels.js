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

async function synchronizeIssueLabels(octokit, owner, repo, targetLabels) {
  try {
    getLogger().info(`Synchronizing labels for ${owner}/${repo}`);

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
