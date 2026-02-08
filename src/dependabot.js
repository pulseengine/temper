import yaml from 'js-yaml';
import { getConfig, getDependabotLabels } from './config.js';
import { getLogger } from './logger.js';
import { upsertRepoFile, createConfigurationPR } from './github-api.js';

async function applyDependabotConfig(octokit, owner, repo, dependabotConfig) {
  const config = getConfig();

  try {
    getLogger().info(`Applying Dependabot configuration to ${owner}/${repo}`);

    const usePR = config.change_strategy?.use_pull_requests || false;
    const yamlContent = yaml.dump(dependabotConfig);

    if (usePR) {
      await createConfigurationPR(
        octokit,
        owner,
        repo,
        '.github/dependabot.yml',
        yamlContent,
        'Update Dependabot configuration'
      );
    } else {
      await upsertRepoFile(
        octokit,
        owner,
        repo,
        '.github/dependabot.yml',
        yamlContent,
        'Add/Update Dependabot configuration'
      );
    }

    getLogger().info(`✅ Applied Dependabot configuration to ${owner}/${repo}`);
  } catch (error) {
    getLogger().error(
      `❌ Error applying Dependabot configuration to ${owner}/${repo}:`,
      error.message
    );
    throw error;
  }
}

async function checkExistingDependabotConfig(octokit, owner, repo) {
  const config = getConfig();

  try {
    getLogger().info(`Checking existing Dependabot configuration for ${owner}/${repo}`);

    try {
      const dependabotResponse = await octokit.request(
        'GET /repos/{owner}/{repo}/contents/.github/dependabot.yml',
        { owner, repo, path: '.github/dependabot.yml' }
      );

      const currentConfig = yaml.load(
        Buffer.from(dependabotResponse.data.content, 'base64').toString('utf8')
      );
      const targetConfig = config.dependabot;
      const expectedLabels = getDependabotLabels(currentConfig);
      const fallbackLabels = getDependabotLabels(targetConfig);
      const labelsToCheck = expectedLabels.length > 0 ? expectedLabels : fallbackLabels;

      const issues = await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
        owner,
        repo,
        state: 'open',
        creator: 'dependabot[bot]',
        per_page: 100
      });

      const dependabotPRs = issues.filter((issue) => issue.pull_request);
      const labelIssues = [];

      dependabotPRs.forEach((pr) => {
        const missingLabels = labelsToCheck.filter(
          (label) => !pr.labels.some((existing) => existing.name === label)
        );

        if (missingLabels.length > 0) {
          labelIssues.push({
            number: pr.number,
            missingLabels
          });
        }
      });

      return {
        exists: true,
        currentConfig,
        matchesTarget: JSON.stringify(currentConfig) === JSON.stringify(targetConfig),
        labelIssues,
        dependabotPRCount: dependabotPRs.length
      };
    } catch (error) {
      if (error.status === 404) {
        return {
          exists: false,
          currentConfig: null,
          matchesTarget: false,
          labelIssues: [],
          dependabotPRCount: 0
        };
      }
      throw error;
    }
  } catch (error) {
    getLogger().error(`❌ Error checking existing Dependabot configuration:`, error.message);
    throw error;
  }
}

async function fixDependabotPRLabels(octokit, owner, repo, labelIssues) {
  try {
    getLogger().info(`Fixing labels for ${labelIssues.length} Dependabot PRs in ${owner}/${repo}`);

    for (const issue of labelIssues) {
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner,
        repo,
        issue_number: issue.number,
        labels: issue.missingLabels
      });
      getLogger().info(
        `✅ Added missing labels to PR #${issue.number}: ${issue.missingLabels.join(', ')}`
      );
    }

    return { success: true, fixedIssues: labelIssues.length };
  } catch (error) {
    getLogger().error(`❌ Error fixing Dependabot PR labels:`, error.message);
    throw error;
  }
}

async function checkDependabotConfiguration(octokit, owner, repo) {
  const config = getConfig();

  try {
    getLogger().info(`Checking Dependabot configuration for ${owner}/${repo}`);

    try {
      const dependabotResponse = await octokit.request(
        'GET /repos/{owner}/{repo}/contents/.github/dependabot.yml',
        { owner, repo, path: '.github/dependabot.yml' }
      );

      const currentConfig = yaml.load(
        Buffer.from(dependabotResponse.data.content, 'base64').toString('utf8')
      );
      const targetConfig = config.dependabot;

      const dependabotCheck = await checkExistingDependabotConfig(octokit, owner, repo);

      let report = `## Dependabot Configuration Check for ${owner}/${repo}\n\n`;

      if (!currentConfig) {
        report += '❌ No Dependabot configuration found. Target configuration should be applied.\n';
      } else {
        report += '### Current Configuration\n';
        report += '```yaml\n';
        report += yaml.dump(currentConfig) + '\n';
        report += '```\n\n';

        report += '### Target Configuration\n';
        report += '```yaml\n';
        report += yaml.dump(targetConfig) + '\n';
        report += '```\n\n';

        if (JSON.stringify(currentConfig) === JSON.stringify(targetConfig)) {
          report += '✅ Dependabot configuration matches target!\n';
        } else {
          report +=
            '⚠️  Dependabot configuration differs from target. Consider running /configure-repo to update.\n';
        }
      }

      report += '\n### Dependabot PR Label Analysis\n';
      if (dependabotCheck.labelIssues.length > 0) {
        report += `⚠️  Found ${dependabotCheck.labelIssues.length} Dependabot PRs with missing labels:\n`;
        dependabotCheck.labelIssues.forEach((issue) => {
          report += `- PR #${issue.number}: Missing labels: ${issue.missingLabels.join(', ')}\n`;
        });
        report += '\nRun `/fix-dependabot-labels` to automatically fix these issues.\n';
      } else {
        report += '✅ All Dependabot PRs have correct labels.\n';
      }

      return report;
    } catch (error) {
      if (error.status === 404) {
        return `❌ No Dependabot configuration found in ${owner}/${repo}. Target configuration should be applied.`;
      }
      throw error;
    }
  } catch (error) {
    getLogger().error(
      `❌ Error checking Dependabot configuration for ${owner}/${repo}:`,
      error.message
    );
    return `❌ Error checking Dependabot configuration: ${error.message}`;
  }
}

export {
  applyDependabotConfig,
  checkExistingDependabotConfig,
  fixDependabotPRLabels,
  checkDependabotConfiguration
};
