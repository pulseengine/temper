'use strict';

const { getConfig } = require('./config');

async function upsertRepoFile(octokit, owner, repo, filePath, content, message, branch) {
  let sha;

  try {
    const existingRequest = { owner, repo, path: filePath };
    if (branch) {
      existingRequest.ref = branch;
    }
    const existing = await octokit.request(
      'GET /repos/{owner}/{repo}/contents/{path}',
      existingRequest
    );

    if (!Array.isArray(existing.data)) {
      sha = existing.data.sha;
    }
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }
  }

  const updateRequest = {
    owner,
    repo,
    path: filePath,
    message,
    content: Buffer.from(content).toString('base64'),
    sha
  };
  if (branch) {
    updateRequest.branch = branch;
  }

  await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', updateRequest);
}

async function createConfigurationPR(octokit, owner, repo, filePath, fileContent, commitMessage) {
  const config = getConfig();

  try {
    console.log(`Creating configuration PR for ${owner}/${repo} - ${filePath}`);

    const repoInfo = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });
    const defaultBranch = repoInfo.data.default_branch || 'main';

    const branchName = `bot/config-update-${Date.now()}`;

    const mainRef = await octokit.request('GET /repos/{owner}/{repo}/git/ref/heads/{branch}', {
      owner,
      repo,
      branch: defaultBranch
    });

    await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: mainRef.data.object.sha
    });

    await upsertRepoFile(octokit, owner, repo, filePath, fileContent, commitMessage, branchName);

    const pr = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
      owner,
      repo,
      title: config.change_strategy?.pr_title || '[Bot] Configuration Update',
      head: branchName,
      base: defaultBranch,
      body: config.change_strategy?.pr_body || 'Automated configuration update',
      maintainer_can_modify: true
    });

    if (config.change_strategy?.pr_labels && config.change_strategy.pr_labels.length > 0) {
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner,
        repo,
        issue_number: pr.data.number,
        labels: config.change_strategy.pr_labels
      });
    }

    if (config.change_strategy?.pr_reviewers && config.change_strategy.pr_reviewers.length > 0) {
      await octokit.request(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers',
        {
          owner,
          repo,
          pull_number: pr.data.number,
          reviewers: config.change_strategy.pr_reviewers
        }
      );
    }

    console.log(`✅ Created configuration PR #${pr.data.number} for ${owner}/${repo}`);
    return pr.data;
  } catch (error) {
    console.error(`❌ Error creating configuration PR for ${owner}/${repo}:`, error.message);
    throw error;
  }
}

module.exports = {
  upsertRepoFile,
  createConfigurationPR
};
