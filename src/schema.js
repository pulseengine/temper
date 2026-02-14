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

  if (config.dependabot !== undefined) {
    if (typeof config.dependabot.version !== 'number') {
      errors.push('dependabot.version must be a number');
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

