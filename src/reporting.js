import { getLogger } from './logger.js';

async function generateConfigurationReport(octokit, owner, repo) {
  try {
    getLogger().info(`Generating configuration report for ${owner}/${repo}`);

    const repoSettings = await octokit.request('GET /repos/{owner}/{repo}', { owner, repo });

    const defaultBranch = repoSettings.data.default_branch || 'main';

    let branchProtection = null;
    try {
      branchProtection = await octokit.request(
        'GET /repos/{owner}/{repo}/branches/{branch}/protection',
        { owner, repo, branch: defaultBranch }
      );
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }

    const currentLabels = await octokit.paginate('GET /repos/{owner}/{repo}/labels', {
      owner,
      repo,
      per_page: 100
    });

    let dependabotConfig = null;
    try {
      const dependabotResponse = await octokit.request(
        'GET /repos/{owner}/{repo}/contents/.github/dependabot.yml',
        { owner, repo, path: '.github/dependabot.yml' }
      );
      dependabotConfig = Buffer.from(dependabotResponse.data.content, 'base64').toString('utf8');
    } catch (error) {
      dependabotConfig = 'No Dependabot configuration found';
    }

    let report = `## Configuration Report for ${owner}/${repo}\n\n`;

    report += '### Repository Settings\n';
    report += `- Merge Commit: ${repoSettings.data.allow_merge_commit}\n`;
    report += `- Squash Merge: ${repoSettings.data.allow_squash_merge}\n`;
    report += `- Rebase Merge: ${repoSettings.data.allow_rebase_merge}\n`;
    report += `- Delete Branch on Merge: ${repoSettings.data.delete_branch_on_merge}\n\n`;

    report += '### Branch Protection\n';
    if (branchProtection?.data) {
      const protection = branchProtection.data;
      report += `- Required Status Checks: ${protection.required_status_checks?.contexts?.join(', ') || 'None'}\n`;
      report += `- Enforce Admins: ${protection.enforce_admins?.enabled || false}\n`;
      report += `- Required Reviews: ${protection.required_pull_request_reviews?.required_approving_review_count || 0}\n`;
      report += `- Dismiss Stale Reviews: ${protection.required_pull_request_reviews?.dismiss_stale_reviews || false}\n`;
      report += `- Require Code Owner Reviews: ${protection.required_pull_request_reviews?.require_code_owner_reviews || false}\n\n`;
    } else {
      report += '- No branch protection configured\n\n';
    }

    report += `### Issue Labels (${currentLabels.length})\n`;
    report += '```\n';
    currentLabels.forEach((label) => {
      report += `${label.name.padEnd(20)} - ${label.color} - ${label.description || ''}\n`;
    });
    report += '```\n\n';

    report += '### Dependabot Configuration\n';
    report += '```yaml\n';
    report += dependabotConfig + '\n';
    report += '```\n';

    return report;
  } catch (error) {
    getLogger().error(
      `❌ Error generating configuration report for ${owner}/${repo}:`,
      error.message
    );
    return `❌ Error generating configuration report: ${error.message}`;
  }
}

async function verifyCIAttestation(octokit, owner, repo, branch, ciConfig) {
  try {
    getLogger().info(`Verifying CI attestation for ${owner}/${repo}`);

    const branchProtection = await octokit.request(
      'GET /repos/{owner}/{repo}/branches/{branch}/protection',
      { owner, repo, branch }
    );

    const requiredChecks = branchProtection.data.required_status_checks.contexts || [];
    const missingChecks = ciConfig.required_checks.filter(
      (check) => !requiredChecks.includes(check)
    );

    if (missingChecks.length > 0) {
      getLogger().warn(`Missing required CI checks: ${missingChecks.join(', ')}`);
      return { compliant: false, missingChecks };
    }

    getLogger().info(`✅ CI attestation verified for ${owner}/${repo}`);
    return { compliant: true };
  } catch (error) {
    getLogger().error(`❌ Error verifying CI attestation for ${owner}/${repo}:`, error.message);
    return { compliant: false, error: error.message };
  }
}

export {
  generateConfigurationReport,
  verifyCIAttestation
};
