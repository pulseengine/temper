/**
 * Validation for config.yml `standards:`. Kept free of imports so schema.js
 * (loaded while config.js initialises) can use it without an import cycle.
 */

export const SHA_RE = /^[0-9a-f]{40}$/;

/** Config-level floor: a standards block that contradicts itself is an error. */
export function validateStandards(config = {}) {
  const errors = [];
  const s = config?.standards;
  if (s === undefined) return errors;
  if (typeof s !== 'object' || s === null) return ['standards must be an object'];
  if (!s.enabled) return errors;

  const bp = config?.branch_protection?.default || {};
  if (s.no_bypass !== false && bp.enforce_admins !== true) {
    errors.push('standards.no_bypass requires branch_protection.default.enforce_admins: true');
  }
  if (s.required_signatures !== false && bp.require_signed_commits !== true && bp.required_signatures !== true) {
    errors.push('standards.required_signatures requires branch_protection.default.require_signed_commits: true');
  }
  if (config?.settings?.merge?.allow_rebase_merge === true && s.required_signatures !== false) {
    errors.push('settings.merge.allow_rebase_merge must be false with required signatures (rebase merges land unsigned commits)');
  }
  if (s.merge_queue?.repos !== undefined && !Array.isArray(s.merge_queue.repos)) {
    errors.push('standards.merge_queue.repos must be an array');
  }
  for (const [i, wf] of (s.required_workflows || []).entries()) {
    if (!wf?.name || !wf?.context || !wf?.path || !wf?.template) {
      errors.push(`standards.required_workflows[${i}] needs name, context, path and template`);
    }
    if (wf?.pin !== undefined && wf.pin !== null && !SHA_RE.test(String(wf.pin))) {
      errors.push(`standards.required_workflows[${i}].pin must be a 40-hex commit sha or null`);
    }
  }
  for (const [name, r] of Object.entries(s.repos || {})) {
    if (r?.required_checks !== undefined && !Array.isArray(r.required_checks)) {
      errors.push(`standards.repos.${name}.required_checks must be an array`);
    }
    if (r?.report_only !== undefined && (typeof r.report_only !== 'string' || !r.report_only)) {
      errors.push(`standards.repos.${name}.report_only must be a non-empty reason string`);
    }
  }
  return errors;
}

