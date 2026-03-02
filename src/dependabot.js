import yaml from 'js-yaml';
import { getConfig, getDependabotLabels } from './config.js';
import { getLogger } from './logger.js';
import { upsertRepoFile, createConfigurationPR } from './github-api.js';
import { detectEcosystems } from './ecosystem-detector.js';
import { callLocalAI } from './ai-review.js';

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

/**
 * Build a dependabot.yml config object from detected ecosystems.
 * @param {Array<{ecosystem: string, directory: string}>} ecosystems
 * @param {object} [genConfig] - dependabot_generation config section
 * @returns {object} dependabot config {version: 2, updates: [...]}
 */
function buildDependabotYaml(ecosystems, genConfig = {}) {
  const schedule = genConfig.default_schedule || 'weekly';
  const labels = genConfig.default_labels || ['dependencies'];

  const updates = ecosystems.map(({ ecosystem, directory }) => ({
    'package-ecosystem': ecosystem,
    directory,
    schedule: { interval: schedule },
    labels
  }));

  return { version: 2, updates };
}

/**
 * Use AI to enhance a heuristic dependabot config (schedules, grouping).
 * Falls back to the base config on any failure.
 * @param {object} baseConfig - heuristic dependabot config
 * @param {string[]} filePaths - repo file tree for context
 * @param {object} aiConfig - ai_review config section
 * @returns {Promise<object>} enhanced or original config
 */
async function enhanceDependabotWithAI(baseConfig, filePaths, aiConfig) {
  try {
    const systemPrompt =
      'You are a Dependabot configuration expert. Given a base dependabot.yml and the repository file tree, ' +
      'improve the configuration with better schedules, grouping strategies, and ignore patterns. ' +
      'Return ONLY valid YAML for a dependabot.yml file (version 2). Do not include markdown fences.';

    const userPrompt =
      `Base dependabot.yml:\n${yaml.dump(baseConfig)}\n\n` +
      `Repository files (sample):\n${filePaths.slice(0, 200).join('\n')}`;

    const response = await callLocalAI(
      aiConfig.endpoint,
      aiConfig.model || 'local-model',
      systemPrompt,
      userPrompt,
      { maxTokens: 2000, temperature: 0.2, timeout: aiConfig.timeout || 60000 }
    );

    if (!response || !response.trim()) {
      getLogger().warn('AI returned empty response for dependabot enhancement, using heuristic');
      return baseConfig;
    }

    const enhanced = yaml.load(response);

    // Validate: must be version 2 with updates array
    if (!enhanced || enhanced.version !== 2 || !Array.isArray(enhanced.updates)) {
      getLogger().warn('AI returned invalid dependabot config, using heuristic');
      return baseConfig;
    }

    // Validate ecosystem values
    const validEcosystems = new Set([
      'npm', 'gomod', 'cargo', 'bundler', 'pip', 'maven', 'gradle',
      'composer', 'docker', 'github-actions', 'mix', 'pub', 'nuget',
      'terraform', 'elm', 'gitsubmodule', 'hex', 'swift'
    ]);
    for (const update of enhanced.updates) {
      if (!validEcosystems.has(update['package-ecosystem'])) {
        getLogger().warn(
          { ecosystem: update['package-ecosystem'] },
          'AI returned unknown ecosystem, using heuristic'
        );
        return baseConfig;
      }
    }

    return enhanced;
  } catch (error) {
    getLogger().warn({ err: error.message }, 'AI enhancement failed, using heuristic config');
    return baseConfig;
  }
}

/**
 * Generate a tailored dependabot.yml for a repository.
 * Fetches the file tree, detects ecosystems, builds config, optionally enhances with AI.
 * @param {object} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} defaultBranch
 * @returns {Promise<{config: object|null, ecosystems: Array, report: string}>}
 */
async function generateDependabotConfig(octokit, owner, repo, defaultBranch) {
  const appConfig = getConfig();
  const genConfig = appConfig.dependabot_generation || {};

  try {
    getLogger().info(`Generating Dependabot config for ${owner}/${repo}`);

    // Fetch the full file tree
    const treeResponse = await octokit.request(
      'GET /repos/{owner}/{repo}/git/trees/{tree_sha}',
      { owner, repo, tree_sha: defaultBranch, recursive: '1' }
    );

    const filePaths = (treeResponse.data.tree || [])
      .filter(item => item.type === 'blob')
      .map(item => item.path);

    // Detect ecosystems
    const ecosystems = detectEcosystems(filePaths, {
      maxDirectoriesPerEcosystem: genConfig.max_directories_per_ecosystem || 5
    });

    if (ecosystems.length === 0) {
      getLogger().info(`No package ecosystems detected in ${owner}/${repo}`);
      return { config: null, ecosystems: [], report: 'No package ecosystems detected.' };
    }

    // Build heuristic config
    let config = buildDependabotYaml(ecosystems, genConfig);

    // Optionally enhance with AI
    const aiConfig = appConfig.ai_review;
    if (genConfig.ai_enhance && aiConfig?.enabled && aiConfig?.endpoint) {
      config = await enhanceDependabotWithAI(config, filePaths, aiConfig);
    }

    const ecosystemList = ecosystems.map(e => `${e.ecosystem} (${e.directory})`).join(', ');
    const report = `Detected ${ecosystems.length} ecosystem(s): ${ecosystemList}`;
    getLogger().info(`Generated Dependabot config for ${owner}/${repo}: ${ecosystemList}`);

    return { config, ecosystems, report };
  } catch (error) {
    getLogger().error(`Error generating Dependabot config for ${owner}/${repo}:`, error.message);
    throw error;
  }
}

export {
  applyDependabotConfig,
  checkExistingDependabotConfig,
  fixDependabotPRLabels,
  checkDependabotConfiguration,
  generateDependabotConfig,
  buildDependabotYaml,
  enhanceDependabotWithAI
};
