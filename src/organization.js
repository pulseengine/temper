import { getTargetIssueLabels, isControlSurfaceRepo } from './config.js';
import { getLogger } from './logger.js';
import { configureRepository } from './repository.js';
import { checkExistingDependabotConfig } from './dependabot.js';

async function checkOrganizationMembership(octokit, org, username) {
  try {
    const response = await octokit.request('GET /orgs/{org}/members/{username}', {
      org,
      username
    });
    return response.status === 204;
  } catch (error) {
    if (error.status === 404) {
      return false;
    }
    getLogger().error('Error checking organization membership:', error.message);
    return false;
  }
}

async function synchronizeAllRepositories(octokit, org) {
  try {
    getLogger().info(`Starting synchronization for organization: ${org}`);

    const repos = await octokit.paginate('GET /orgs/{org}/repos', {
      org,
      type: 'all',
      per_page: 100
    });

    getLogger().info(`Found ${repos.length} repositories to synchronize`);

    for (const repo of repos) {
      if (repo.archived) {
        getLogger().info(`Skipping archived repository: ${repo.full_name}`);
        continue;
      }

      if (isControlSurfaceRepo(repo.full_name)) {
        getLogger().info(`Skipping control-surface repository: ${repo.full_name}`);
        continue;
      }

      getLogger().info(`Processing repository: ${repo.full_name}`);
      const configResult = await configureRepository(octokit, repo);
      if (!configResult.success) {
        getLogger().warn(`⚠️  Failed to configure ${repo.full_name}: ${configResult.error}`);
      } else {
        getLogger().info(`✅ Synchronized ${repo.full_name}`);
      }
    }

    getLogger().info(`✅ Completed synchronization for organization: ${org}`);
    return { success: true, repositoriesProcessed: repos.length };
  } catch (error) {
    getLogger().error(`❌ Error synchronizing repositories:`, error.message);
    return { success: false, error: error.message };
  }
}

async function analyzeOrganizationRepositories(octokit, org) {
  try {
    getLogger().info(`Analyzing all repositories in organization: ${org}`);

    const repos = await octokit.paginate('GET /orgs/{org}/repos', {
      org,
      type: 'all',
      per_page: 100
    });

    getLogger().info(`Found ${repos.length} repositories to analyze`);

    const nonForkRepos = repos.filter((repo) => !repo.fork);
    getLogger().info(`Analyzing ${nonForkRepos.length} non-fork repositories`);

    const targetLabels = getTargetIssueLabels();

    const analysisResults = [];

    for (const repo of nonForkRepos) {
      if (repo.archived) {
        getLogger().info(`Skipping archived repository: ${repo.full_name}`);
        continue;
      }

      getLogger().info(`Analyzing repository: ${repo.full_name}`);

      const repoAnalysis = {
        name: repo.name,
        full_name: repo.full_name,
        created_at: repo.created_at,
        updated_at: repo.updated_at,
        size: repo.size,
        stargazers_count: repo.stargazers_count,
        forks_count: repo.forks_count,
        open_issues_count: repo.open_issues_count,
        has_issues: repo.has_issues,
        has_projects: repo.has_projects,
        has_wiki: repo.has_wiki,
        configurations: {}
      };

      try {
        const repoSettings = await octokit.request('GET /repos/{owner}/{repo}', {
          owner: repo.owner.login,
          repo: repo.name
        });

        repoAnalysis.configurations.merge_settings = {
          allow_merge_commit: repoSettings.data.allow_merge_commit,
          allow_squash_merge: repoSettings.data.allow_squash_merge,
          allow_rebase_merge: repoSettings.data.allow_rebase_merge,
          delete_branch_on_merge: repoSettings.data.delete_branch_on_merge
        };
      } catch (error) {
        getLogger().error(`Error getting settings for ${repo.full_name}:`, error.message);
        repoAnalysis.configurations.merge_settings = { error: error.message };
      }

      const defaultBranch = repo.default_branch || 'main';

      try {
        const branchProtection = await octokit.request(
          'GET /repos/{owner}/{repo}/branches/{branch}/protection',
          { owner: repo.owner.login, repo: repo.name, branch: defaultBranch }
        );

        repoAnalysis.configurations.branch_protection = {
          exists: true,
          required_status_checks:
            branchProtection.data.required_status_checks?.contexts || [],
          enforce_admins: branchProtection.data.enforce_admins?.enabled || false,
          required_reviews:
            branchProtection.data.required_pull_request_reviews
              ?.required_approving_review_count || 0
        };
      } catch (error) {
        if (error.status === 404) {
          repoAnalysis.configurations.branch_protection = { exists: false };
        } else {
          getLogger().error(
            `Error getting branch protection for ${repo.full_name}:`,
            error.message
          );
          repoAnalysis.configurations.branch_protection = { error: error.message };
        }
      }

      try {
        const dependabotCheck = await checkExistingDependabotConfig(
          octokit,
          repo.owner.login,
          repo.name
        );
        repoAnalysis.configurations.dependabot = {
          exists: dependabotCheck.exists,
          matches_target: dependabotCheck.matchesTarget,
          pr_count: dependabotCheck.dependabotPRCount,
          label_issues: dependabotCheck.labelIssues.length
        };
      } catch (error) {
        getLogger().error(`Error checking Dependabot for ${repo.full_name}:`, error.message);
        repoAnalysis.configurations.dependabot = { error: error.message };
      }

      try {
        const currentLabels = await octokit.paginate('GET /repos/{owner}/{repo}/labels', {
          owner: repo.owner.login,
          repo: repo.name,
          per_page: 100
        });

        repoAnalysis.configurations.labels = {
          count: currentLabels.length,
          standard_labels: currentLabels
            .filter((label) => targetLabels.some((target) => target.name === label.name))
            .map((label) => label.name)
        };
      } catch (error) {
        getLogger().error(`Error checking labels for ${repo.full_name}:`, error.message);
        repoAnalysis.configurations.labels = { error: error.message };
      }

      analysisResults.push(repoAnalysis);
    }

    getLogger().info(`✅ Completed analysis for organization: ${org}`);
    return { success: true, repositories: analysisResults };
  } catch (error) {
    getLogger().error(`❌ Error analyzing organization repositories:`, error.message);
    return { success: false, error: error.message };
  }
}

async function generateOrganizationAnalysisReport(octokit, org) {
  try {
    const analysis = await analyzeOrganizationRepositories(octokit, org);

    if (!analysis.success) {
      return `❌ Error analyzing organization: ${analysis.error}`;
    }

    const repos = analysis.repositories;
    const targetLabels = getTargetIssueLabels();

    let report = `# Organization Repository Analysis Report\n\n`;
    report += `## Summary\n\n`;
    report += `- Total Repositories: ${repos.length}\n`;

    const withBranchProtection = repos.filter(
      (r) => r.configurations.branch_protection?.exists
    );
    const withDependabot = repos.filter((r) => r.configurations.dependabot?.exists);
    const withStandardLabels = repos.filter(
      (r) => r.configurations.labels?.standard_labels?.length >= targetLabels.length / 2
    );

    report += `- With Branch Protection: ${withBranchProtection.length}\n`;
    report += `- With Dependabot Config: ${withDependabot.length}\n`;
    report += `- With Standard Labels: ${withStandardLabels.length}\n\n`;

    const correctMergeSettings = repos.filter(
      (r) =>
        r.configurations.merge_settings?.allow_merge_commit === false &&
        r.configurations.merge_settings?.allow_squash_merge === false &&
        r.configurations.merge_settings?.allow_rebase_merge === true &&
        r.configurations.merge_settings?.delete_branch_on_merge === true
    );

    report += `- With Correct Merge Settings: ${correctMergeSettings.length}\n\n`;

    const dependabotLabelIssues = repos.reduce(
      (sum, r) => sum + (r.configurations.dependabot?.label_issues || 0),
      0
    );

    report += `- Dependabot PRs with Label Issues: ${dependabotLabelIssues}\n\n`;

    report += `## Detailed Repository Analysis\n\n`;

    repos.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));

    repos.forEach((repo) => {
      report += `### ${repo.full_name}\n\n`;
      report += `- Created: ${repo.created_at} | Updated: ${repo.updated_at}\n`;
      report += `- Size: ${repo.size} KB | Stars: ${repo.stargazers_count} | Forks: ${repo.forks_count}\n`;
      report += `- Open Issues: ${repo.open_issues_count}\n\n`;

      report += `#### Merge Settings\n`;
      const mergeSettings = repo.configurations.merge_settings;
      if (mergeSettings.error) {
        report += `- ❌ Error: ${mergeSettings.error}\n`;
      } else {
        report += `- Merge Commit: ${mergeSettings.allow_merge_commit ? '❌ Enabled' : '✅ Disabled'}\n`;
        report += `- Squash Merge: ${mergeSettings.allow_squash_merge ? '❌ Enabled' : '✅ Disabled'}\n`;
        report += `- Rebase Merge: ${mergeSettings.allow_rebase_merge ? '✅ Enabled' : '❌ Disabled'}\n`;
        report += `- Delete Branch: ${mergeSettings.delete_branch_on_merge ? '✅ Enabled' : '❌ Disabled'}\n`;
      }
      report += '\n';

      report += `#### Branch Protection\n`;
      const branchProtection = repo.configurations.branch_protection;
      if (branchProtection.exists) {
        report += `- ✅ Branch protection enabled\n`;
        report += `- Required Checks: ${branchProtection.required_status_checks.join(', ') || 'None'}\n`;
        report += `- Enforce Admins: ${branchProtection.enforce_admins ? '✅ Yes' : '❌ No'}\n`;
        report += `- Required Reviews: ${branchProtection.required_reviews}\n`;
      } else if (branchProtection.exists === false) {
        report += `- ❌ No branch protection configured\n`;
      } else {
        report += `- ❌ Error: ${branchProtection.error}\n`;
      }
      report += '\n';

      report += `#### Dependabot\n`;
      const dependabot = repo.configurations.dependabot;
      if (dependabot.exists) {
        report += `- ✅ Dependabot config exists\n`;
        report += `- Matches Target: ${dependabot.matches_target ? '✅ Yes' : '❌ No'}\n`;
        report += `- Open PRs: ${dependabot.pr_count}\n`;
        if (dependabot.label_issues > 0) {
          report += `- ⚠️  ${dependabot.label_issues} PRs with label issues\n`;
        }
      } else if (dependabot.exists === false) {
        report += `- ❌ No Dependabot configuration\n`;
      } else {
        report += `- ❌ Error: ${dependabot.error}\n`;
      }
      report += '\n';

      report += `#### Labels\n`;
      const labels = repo.configurations.labels;
      if (labels.count !== undefined) {
        report += `- Total Labels: ${labels.count}\n`;
        report += `- Standard Labels: ${labels.standard_labels?.length || 0}/${targetLabels.length}\n`;

        const missingStandardLabels = targetLabels.filter(
          (target) => !labels.standard_labels?.includes(target.name)
        );

        if (missingStandardLabels.length > 0) {
          report += `- Missing Standard Labels: ${missingStandardLabels.map((l) => l.name).join(', ')}\n`;
        }
      } else {
        report += `- ❌ Error: ${labels.error}\n`;
      }
      report += '\n---\n\n';
    });

    report += `## Recommendations\n\n`;

    if (correctMergeSettings.length < repos.length) {
      report += `- 🔧 Standardize merge settings across all repositories\n`;
    }

    if (withBranchProtection.length < repos.length) {
      report += `- 🛡️  Enable branch protection on ${repos.length - withBranchProtection.length} repositories\n`;
    }

    if (withDependabot.length < repos.length) {
      report += `- 🤖 Add Dependabot configuration to ${repos.length - withDependabot.length} repositories\n`;
    }

    if (dependabotLabelIssues > 0) {
      report += `- 🏷️  Fix label issues on ${dependabotLabelIssues} Dependabot PRs\n`;
    }

    if (withStandardLabels.length < repos.length) {
      report += `- 📋 Standardize labels across all repositories\n`;
    }

    report += `\n## Next Steps\n\n`;
    report += `- Run \\\`/sync-all-repos\\\` to apply standard configurations\n`;
    report += `- Run \\\`/analyze-org\\\` to get updated analysis after changes\n`;
    report += `- Review and merge configuration PRs created by the bot\n`;

    return report;
  } catch (error) {
    getLogger().error(`❌ Error generating organization analysis report:`, error.message);
    return `❌ Error generating report: ${error.message}`;
  }
}

export {
  checkOrganizationMembership,
  synchronizeAllRepositories,
  analyzeOrganizationRepositories,
  generateOrganizationAnalysisReport
};
