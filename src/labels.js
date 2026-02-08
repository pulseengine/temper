'use strict';

async function synchronizeIssueLabels(octokit, owner, repo, targetLabels) {
  try {
    console.log(`Synchronizing labels for ${owner}/${repo}`);

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
          console.log(`Updated label: ${targetLabel.name}`);
        }
      } else {
        await octokit.request('POST /repos/{owner}/{repo}/labels', {
          owner,
          repo,
          name: targetLabel.name,
          color: targetLabel.color,
          description: targetLabel.description
        });
        console.log(`Created label: ${targetLabel.name}`);
      }
    }

    for (const currentLabel of currentLabels) {
      if (!targetLabels.some((tl) => tl.name === currentLabel.name)) {
        await octokit.request('DELETE /repos/{owner}/{repo}/labels/{name}', {
          owner,
          repo,
          name: currentLabel.name
        });
        console.log(`Removed label: ${currentLabel.name}`);
      }
    }

    console.log(`✅ Synchronized labels for ${owner}/${repo}`);
  } catch (error) {
    console.error(`❌ Error synchronizing labels for ${owner}/${repo}:`, error.message);
    throw error;
  }
}

module.exports = {
  synchronizeIssueLabels
};
