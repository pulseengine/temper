import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { isForkRepo, getDefaultBranch } from './helpers.js';
import { validateConfig } from './schema.js';
import { getLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_MERGE_SETTINGS = {
  allow_merge_commit: false,
  allow_squash_merge: false,
  allow_rebase_merge: true,
  delete_branch_on_merge: true
};

export const DEPENDABOT_LABEL_DEFAULTS = {
  dependencies: {
    color: '0366d6',
    description: 'Dependency updates'
  },
  automation: {
    color: '0e8a16',
    description: 'Automation updates'
  }
};

const CONFIG_PATH = path.join(__dirname, '..', 'config.yml');
const LOCAL_CONFIG_PATH = path.join(__dirname, '..', 'config.local.yml');
let config = {};
let TARGET_SETTINGS = { ...DEFAULT_MERGE_SETTINGS };

/**
 * Deep-merge source into target. Objects merge recursively;
 * arrays and primitives from source replace target values.
 */
export function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      typeof srcVal === 'object' &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === 'object' &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(tgtVal, srcVal);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

export function loadConfig() {
  try {
    config = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};

    if (fs.existsSync(LOCAL_CONFIG_PATH)) {
      const localConfig = yaml.load(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8')) || {};
      config = deepMerge(config, localConfig);
      getLogger().info('Merged local overrides from config.local.yml');
    }

    TARGET_SETTINGS = config?.settings?.merge || { ...DEFAULT_MERGE_SETTINGS };
    const validation = validateConfig(config);
    if (!validation.valid) {
      getLogger().warn({ errors: validation.errors }, 'Config validation warnings');
    }
    getLogger().info('Configuration loaded from config.yml');
  } catch (error) {
    getLogger().error({ err: error }, 'Error loading config.yml, using default settings');
    config = {};
    TARGET_SETTINGS = { ...DEFAULT_MERGE_SETTINGS };
  }
}

loadConfig();

export function getConfig() {
  return config;
}

export function getTargetSettings() {
  return TARGET_SETTINGS;
}

/** Replace config and TARGET_SETTINGS for testing purposes. */
export function _setConfigForTesting(newConfig) {
  config = newConfig;
  TARGET_SETTINGS = newConfig?.settings?.merge || { ...DEFAULT_MERGE_SETTINGS };
}

export function getMergeSettings(repoInfo) {
  if (isForkRepo(repoInfo) && config?.forks?.merge) {
    return {
      ...TARGET_SETTINGS,
      ...config.forks.merge
    };
  }

  return TARGET_SETTINGS;
}

export function getBranchProtectionConfig(repoInfo) {
  const defaultBranch = getDefaultBranch(repoInfo);
  const protection = config?.branch_protection || {};

  const baseConfig =
    protection[defaultBranch] ||
    protection.default ||
    protection.main ||
    protection;

  if (isForkRepo(repoInfo) && protection.fork_overrides) {
    return {
      ...baseConfig,
      ...protection.fork_overrides
    };
  }

  return baseConfig;
}

export function mergePullRequestRules(protectionConfig = {}) {
  if (!config?.pull_request_rules) {
    return protectionConfig;
  }

  const merged = { ...protectionConfig };

  if (protectionConfig.required_pull_request_reviews !== null) {
    merged.required_pull_request_reviews = {
      required_approving_review_count: config.pull_request_rules.required_approving_reviews,
      dismiss_stale_reviews: config.pull_request_rules.dismiss_stale_reviews,
      require_code_owner_reviews: config.pull_request_rules.require_code_owner_reviews,
      require_last_push_approval: config.pull_request_rules.require_last_push_approval
    };
  }

  if (protectionConfig.required_status_checks !== null) {
    merged.required_status_checks = {
      strict: true,
      contexts: config.pull_request_rules.required_status_checks || []
    };
  }

  return merged;
}

export function getRulesetConfig() {
  return config?.rulesets || { enabled: false };
}

export function getControllerRepoConfig() {
  return config?.controller_repo || { enabled: false };
}

export function getChatopsRepoConfig() {
  return config?.chatops_repo || { enabled: false };
}

export function getRequiredSignaturesFlag(protectionConfig = {}) {
  if (typeof protectionConfig.require_signed_commits === 'boolean') {
    return protectionConfig.require_signed_commits;
  }
  if (typeof protectionConfig.required_signatures === 'boolean') {
    return protectionConfig.required_signatures;
  }
  return null;
}

export function getDependabotLabels(dependabotConfig = {}) {
  if (!dependabotConfig || !Array.isArray(dependabotConfig.updates)) {
    return [];
  }

  const labels = new Set();
  dependabotConfig.updates.forEach((update) => {
    if (Array.isArray(update.labels)) {
      update.labels.forEach((label) => labels.add(label));
    }
  });

  return Array.from(labels);
}

export function getTargetIssueLabels() {
  const baseLabels = Array.isArray(config?.issue_labels) ? [...config.issue_labels] : [];
  const dependabotLabels = getDependabotLabels(config?.dependabot);
  const genLabels = config?.dependabot_generation?.default_labels || [];
  const allDependabotLabels = [...new Set([...dependabotLabels, ...genLabels])];

  const existingNames = new Set(baseLabels.map((label) => label.name));
  allDependabotLabels.forEach((labelName) => {
    if (!existingNames.has(labelName)) {
      const defaults = DEPENDABOT_LABEL_DEFAULTS[labelName] || {
        color: 'ededed',
        description: 'Automated label'
      };
      baseLabels.push({
        name: labelName,
        color: defaults.color,
        description: defaults.description
      });
    }
  });

  return baseLabels;
}
