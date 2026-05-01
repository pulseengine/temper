export function validateConfig(config) {
  const errors = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be a non-null object'] };
  }

  if (config.organization !== undefined && (typeof config.organization !== 'string' || config.organization.length === 0)) {
    errors.push('organization must be a non-empty string');
  }

  if (config.bot_name !== undefined && typeof config.bot_name !== 'string') {
    errors.push('bot_name must be a string');
  }

  if (config.allowed_command_users !== undefined && !Array.isArray(config.allowed_command_users)) {
    errors.push('allowed_command_users must be an array');
  }

  if (config.settings?.merge) {
    const merge = config.settings.merge;
    const boolFields = ['allow_merge_commit', 'allow_squash_merge', 'allow_rebase_merge', 'delete_branch_on_merge'];
    for (const field of boolFields) {
      if (merge[field] !== undefined && typeof merge[field] !== 'boolean') {
        errors.push(`settings.merge.${field} must be a boolean`);
      }
    }
  }

  if (config.branch_protection?.default) {
    const bp = config.branch_protection.default;
    if (bp.enforce_admins !== undefined && typeof bp.enforce_admins !== 'boolean') {
      errors.push('branch_protection.default.enforce_admins must be a boolean');
    }
  }

  if (config.issue_labels !== undefined) {
    if (!Array.isArray(config.issue_labels)) {
      errors.push('issue_labels must be an array');
    } else {
      config.issue_labels.forEach((label, i) => {
        if (!label.name || typeof label.name !== 'string') {
          errors.push(`issue_labels[${i}].name must be a non-empty string`);
        }
        if (!label.color || typeof label.color !== 'string') {
          errors.push(`issue_labels[${i}].color must be a non-empty string`);
        }
      });
    }
  }

  if (config.issue_labels_sync_mode !== undefined) {
    const validModes = ['merge', 'replace'];
    if (!validModes.includes(config.issue_labels_sync_mode)) {
      errors.push('issue_labels_sync_mode must be one of: merge, replace');
    }
  }

  if (config.dependabot !== undefined) {
    if (typeof config.dependabot.version !== 'number') {
      errors.push('dependabot.version must be a number');
    }
  }

  if (config.self_update !== undefined) {
    const su = config.self_update;
    if (typeof su !== 'object' || su === null) {
      errors.push('self_update must be an object');
    } else {
      if (su.enabled !== undefined && typeof su.enabled !== 'boolean') {
        errors.push('self_update.enabled must be a boolean');
      }
      if (su.repo !== undefined && (typeof su.repo !== 'string' || su.repo.length === 0)) {
        errors.push('self_update.repo must be a non-empty string');
      }
      if (su.branch !== undefined && typeof su.branch !== 'string') {
        errors.push('self_update.branch must be a string');
      }
    }
  }

  if (config.dependabot_generation !== undefined) {
    const dg = config.dependabot_generation;
    if (typeof dg !== 'object' || dg === null) {
      errors.push('dependabot_generation must be an object');
    } else {
      if (dg.enabled !== undefined && typeof dg.enabled !== 'boolean') {
        errors.push('dependabot_generation.enabled must be a boolean');
      }
      if (dg.ai_enhance !== undefined && typeof dg.ai_enhance !== 'boolean') {
        errors.push('dependabot_generation.ai_enhance must be a boolean');
      }
      if (dg.default_schedule !== undefined) {
        const validSchedules = ['daily', 'weekly', 'monthly'];
        if (!validSchedules.includes(dg.default_schedule)) {
          errors.push('dependabot_generation.default_schedule must be one of: daily, weekly, monthly');
        }
      }
      if (dg.default_labels !== undefined && !Array.isArray(dg.default_labels)) {
        errors.push('dependabot_generation.default_labels must be an array');
      }
      if (dg.max_directories_per_ecosystem !== undefined) {
        if (typeof dg.max_directories_per_ecosystem !== 'number' || dg.max_directories_per_ecosystem < 1) {
          errors.push('dependabot_generation.max_directories_per_ecosystem must be a positive number');
        }
      }
    }
  }

  if (config.scheduler !== undefined) {
    const sc = config.scheduler;
    if (typeof sc !== 'object' || sc === null) {
      errors.push('scheduler must be an object');
    } else {
      if (sc.interval_minutes !== undefined) {
        if (typeof sc.interval_minutes !== 'number' || sc.interval_minutes < 1) {
          errors.push('scheduler.interval_minutes must be a positive number');
        }
      }
      if (sc.max_tasks_per_tick !== undefined) {
        if (typeof sc.max_tasks_per_tick !== 'number' || sc.max_tasks_per_tick < 1) {
          errors.push('scheduler.max_tasks_per_tick must be a positive number');
        }
      }
      if (sc.rate_limit_threshold !== undefined) {
        if (typeof sc.rate_limit_threshold !== 'number' || sc.rate_limit_threshold < 0) {
          errors.push('scheduler.rate_limit_threshold must be a non-negative number');
        }
      }
    }
  }

  if (config.rulesets !== undefined) {
    const rs = config.rulesets;
    if (typeof rs !== 'object' || rs === null) {
      errors.push('rulesets must be an object');
    } else {
      if (rs.enabled !== undefined && typeof rs.enabled !== 'boolean') {
        errors.push('rulesets.enabled must be a boolean');
      }
      if (rs.fall_back_to_legacy !== undefined && typeof rs.fall_back_to_legacy !== 'boolean') {
        errors.push('rulesets.fall_back_to_legacy must be a boolean');
      }
      if (rs.name !== undefined && (typeof rs.name !== 'string' || rs.name.length === 0)) {
        errors.push('rulesets.name must be a non-empty string');
      }
    }
  }

  if (config.change_strategy !== undefined) {
    const cs = config.change_strategy;
    if (typeof cs !== 'object' || cs === null) {
      errors.push('change_strategy must be an object');
    } else {
      if (cs.use_pull_requests !== undefined && typeof cs.use_pull_requests !== 'boolean') {
        errors.push('change_strategy.use_pull_requests must be a boolean');
      }
      if (cs.pr_labels !== undefined && !Array.isArray(cs.pr_labels)) {
        errors.push('change_strategy.pr_labels must be an array');
      }
    }
  }

  if (config.controller_repo !== undefined) {
    const cr = config.controller_repo;
    if (typeof cr !== 'object' || cr === null) {
      errors.push('controller_repo must be an object');
    } else {
      if (cr.enabled !== undefined && typeof cr.enabled !== 'boolean') {
        errors.push('controller_repo.enabled must be a boolean');
      }
      if (cr.enabled && (typeof cr.repo !== 'string' || !cr.repo.includes('/'))) {
        errors.push('controller_repo.repo must be "owner/repo" when enabled');
      }
      if (cr.label !== undefined && typeof cr.label !== 'string') {
        errors.push('controller_repo.label must be a string');
      }
    }
  }

  if (config.chatops_repo !== undefined) {
    const cr = config.chatops_repo;
    if (typeof cr !== 'object' || cr === null) {
      errors.push('chatops_repo must be an object');
    } else {
      if (cr.enabled !== undefined && typeof cr.enabled !== 'boolean') {
        errors.push('chatops_repo.enabled must be a boolean');
      }
      if (cr.enabled && (typeof cr.repo !== 'string' || !cr.repo.includes('/'))) {
        errors.push('chatops_repo.repo must be "owner/repo" when enabled');
      }
    }
  }

  if (config.rivet_oracle !== undefined) {
    const ro = config.rivet_oracle;
    if (typeof ro !== 'object' || ro === null) {
      errors.push('rivet_oracle must be an object');
    } else {
      if (ro.enabled !== undefined && typeof ro.enabled !== 'boolean') {
        errors.push('rivet_oracle.enabled must be a boolean');
      }
      if (ro.binary_path !== undefined && typeof ro.binary_path !== 'string') {
        errors.push('rivet_oracle.binary_path must be a string');
      }
      if (ro.timeout_ms !== undefined &&
          (typeof ro.timeout_ms !== 'number' || ro.timeout_ms < 1000)) {
        errors.push('rivet_oracle.timeout_ms must be a number >= 1000');
      }
    }
  }

  if (config.ai_review?.enabled) {
    if (config.ai_review.endpoint !== undefined && typeof config.ai_review.endpoint !== 'string') {
      errors.push('ai_review.endpoint must be a string');
    }
    if (config.ai_review.temperature !== undefined) {
      const temp = config.ai_review.temperature;
      if (typeof temp !== 'number' || temp < 0 || temp > 1) {
        errors.push('ai_review.temperature must be a number between 0 and 1');
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
