'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { isForkRepo, getDefaultBranch } = require('./helpers');

const DEFAULT_MERGE_SETTINGS = {
  allow_merge_commit: false,
  allow_squash_merge: false,
  allow_rebase_merge: true,
  delete_branch_on_merge: true
};

const DEPENDABOT_LABEL_DEFAULTS = {
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
let config = {};
let TARGET_SETTINGS = { ...DEFAULT_MERGE_SETTINGS };

function loadConfig() {
  try {
    config = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) || {};
    TARGET_SETTINGS = config?.settings?.merge || { ...DEFAULT_MERGE_SETTINGS };
    console.log('Configuration loaded from config.yml');
  } catch (error) {
    console.error('Error loading config.yml, using default settings:', error.message);
    config = {};
    TARGET_SETTINGS = { ...DEFAULT_MERGE_SETTINGS };
  }
}

loadConfig();

function getConfig() {
  return config;
}

function getTargetSettings() {
  return TARGET_SETTINGS;
}

/** Replace config and TARGET_SETTINGS for testing purposes. */
function _setConfigForTesting(newConfig) {
  config = newConfig;
  TARGET_SETTINGS = newConfig?.settings?.merge || { ...DEFAULT_MERGE_SETTINGS };
}

function getMergeSettings(repoInfo) {
  if (isForkRepo(repoInfo) && config?.forks?.merge) {
    return {
      ...TARGET_SETTINGS,
      ...config.forks.merge
    };
  }

  return TARGET_SETTINGS;
}

function getBranchProtectionConfig(repoInfo) {
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

function mergePullRequestRules(protectionConfig = {}) {
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

function getRequiredSignaturesFlag(protectionConfig = {}) {
  if (typeof protectionConfig.require_signed_commits === 'boolean') {
    return protectionConfig.require_signed_commits;
  }
  if (typeof protectionConfig.required_signatures === 'boolean') {
    return protectionConfig.required_signatures;
  }
  return null;
}

function getDependabotLabels(dependabotConfig = {}) {
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

function getTargetIssueLabels() {
  const baseLabels = Array.isArray(config?.issue_labels) ? [...config.issue_labels] : [];
  const dependabotLabels = getDependabotLabels(config?.dependabot);

  const existingNames = new Set(baseLabels.map((label) => label.name));
  dependabotLabels.forEach((labelName) => {
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

module.exports = {
  DEFAULT_MERGE_SETTINGS,
  DEPENDABOT_LABEL_DEFAULTS,
  loadConfig,
  getConfig,
  getTargetSettings,
  _setConfigForTesting,
  getMergeSettings,
  getBranchProtectionConfig,
  mergePullRequestRules,
  getRequiredSignaturesFlag,
  getDependabotLabels,
  getTargetIssueLabels
};
