'use strict';

const { getRequiredSignaturesFlag } = require('./config');

async function applyBranchProtection(octokit, owner, repo, branch, protectionConfig = {}) {
  try {
    console.log(`Applying branch protection to ${owner}/${repo}@${branch}`);

    const requiredStatusChecks =
      protectionConfig.required_status_checks === null
        ? null
        : {
            strict: protectionConfig.required_status_checks?.strict || false,
            contexts: protectionConfig.required_status_checks?.contexts || []
          };

    await octokit.request('PUT /repos/{owner}/{repo}/branches/{branch}/protection', {
      owner,
      repo,
      branch,
      required_status_checks: requiredStatusChecks,
      enforce_admins: protectionConfig.enforce_admins ?? false,
      required_pull_request_reviews: protectionConfig.required_pull_request_reviews ?? null,
      restrictions: protectionConfig.restrictions ?? null,
      required_linear_history: protectionConfig.required_linear_history ?? false,
      allow_force_pushes: protectionConfig.allow_force_pushes ?? false,
      allow_deletions: protectionConfig.allow_deletions ?? false,
      required_conversation_resolution: protectionConfig.required_conversation_resolution ?? false
    });

    const requiredSignatures = getRequiredSignaturesFlag(protectionConfig);
    if (requiredSignatures !== null) {
      await setRequiredSignatures(octokit, owner, repo, branch, requiredSignatures);
    }

    console.log(`✅ Branch protection applied to ${owner}/${repo}`);
  } catch (error) {
    console.error(`❌ Error applying branch protection to ${owner}/${repo}:`, error.message);
    throw error;
  }
}

async function setRequiredSignatures(octokit, owner, repo, branch, enabled) {
  try {
    if (enabled) {
      await octokit.request(
        'POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures',
        { owner, repo, branch }
      );
    } else {
      await octokit.request(
        'DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures',
        { owner, repo, branch }
      );
    }
  } catch (error) {
    if (error.status === 404 || error.status === 422) {
      console.warn(
        `⚠️  Required signatures not supported for ${owner}/${repo}@${branch}: ${error.message}`
      );
      return;
    }
    throw error;
  }
}

module.exports = {
  applyBranchProtection,
  setRequiredSignatures
};
