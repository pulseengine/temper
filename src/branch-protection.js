import { getRequiredSignaturesFlag } from './config.js';
import { getLogger } from './logger.js';

async function applyBranchProtection(octokit, owner, repo, branch, protectionConfig = {}) {
  try {
    getLogger().info(`Applying branch protection to ${owner}/${repo}@${branch}`);

    // PUT replaces classic protection wholesale. Keep the contexts the repo
    // already requires, or a sync would silently empty a per-repo gate
    // (e.g. a 19-context list) down to the org's empty default.
    const existingContexts = await getExistingContexts(octokit, owner, repo, branch);
    const requiredStatusChecks =
      protectionConfig.required_status_checks === null
        ? null
        : {
            strict: protectionConfig.required_status_checks?.strict || false,
            contexts: [
              ...new Set([...(protectionConfig.required_status_checks?.contexts || []), ...existingContexts])
            ]
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

    getLogger().info(`✅ Branch protection applied to ${owner}/${repo}`);
  } catch (error) {
    getLogger().error(`❌ Error applying branch protection to ${owner}/${repo}:`, error.message);
    throw error;
  }
}

async function getExistingContexts(octokit, owner, repo, branch) {
  try {
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
      owner,
      repo,
      branch
    });
    const rsc = data?.required_status_checks;
    return [...(rsc?.contexts || []), ...(rsc?.checks || []).map((c) => c.context)];
  } catch (error) {
    if (error.status === 404) return [];
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
      getLogger().warn(
        `⚠️  Required signatures not supported for ${owner}/${repo}@${branch}: ${error.message}`
      );
      return;
    }
    throw error;
  }
}

export {
  applyBranchProtection,
  setRequiredSignatures
};
