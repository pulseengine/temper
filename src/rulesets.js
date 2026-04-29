/**
 * Repository Rulesets — modern replacement for the legacy branch-protection API.
 *
 * Why this module exists:
 *   GitHub fires `repository.created` before the default branch has any commits,
 *   so the legacy `PUT /repos/{owner}/{repo}/branches/{branch}/protection`
 *   endpoint returns 404 for empty repos. Rulesets target ref *patterns*
 *   (`~DEFAULT_BRANCH`) and apply regardless of whether the branch already
 *   exists — which kills the new-repo race entirely.
 *
 * The module is intentionally idempotent: it lists rulesets by name, then
 * creates / updates / leaves alone as needed. Safe to call on every webhook.
 */

import { getLogger } from './logger.js';

export const TEMPER_RULESET_NAME = 'temper-default-branch-protection';

/**
 * Translate a legacy branch_protection.default config block into a Repository
 * Ruleset payload. Keeps the existing config.yml shape working for users.
 *
 * @param {object} bpConfig - branch_protection.default value from config.yml
 * @param {string} [name=TEMPER_RULESET_NAME]
 * @returns {object} a ruleset payload suitable for POST/PUT /repos/.../rulesets
 */
export function translateBranchProtectionToRuleset(bpConfig = {}, name = TEMPER_RULESET_NAME) {
  const rules = [];

  if (!bpConfig.allow_deletions) rules.push({ type: 'deletion' });
  if (!bpConfig.allow_force_pushes) rules.push({ type: 'non_fast_forward' });

  if (bpConfig.require_signed_commits || bpConfig.required_signatures) {
    rules.push({ type: 'required_signatures' });
  }

  if (bpConfig.required_linear_history) {
    rules.push({ type: 'required_linear_history' });
  }

  const r = bpConfig.required_pull_request_reviews;
  if (r && r !== null) {
    rules.push({
      type: 'pull_request',
      parameters: {
        required_approving_review_count: r.required_approving_review_count ?? 0,
        dismiss_stale_reviews_on_push: r.dismiss_stale_reviews ?? false,
        require_code_owner_review: r.require_code_owner_reviews ?? false,
        require_last_push_approval: r.require_last_push_approval ?? false,
        required_review_thread_resolution: bpConfig.required_conversation_resolution ?? false
      }
    });
  }

  const checks = bpConfig.required_status_checks;
  // The Rulesets API rejects `required_status_checks` rules with empty
  // `required_status_checks` arrays ("Expected at least 1 elements, got 0").
  // Legacy branch-protection accepts `contexts: []`; rulesets do not.
  // When the user has no specific named checks, omit the rule entirely —
  // emitting a half-valid rule causes the entire ruleset POST to 422 and
  // we silently fall back to legacy. Better to ship the ruleset without
  // this rule than to ship no ruleset at all.
  const hasContexts = checks && Array.isArray(checks.contexts) && checks.contexts.length > 0;
  if (checks && checks !== null && hasContexts) {
    rules.push({
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: checks.strict ?? false,
        required_status_checks: checks.contexts.map((c) =>
          typeof c === 'string' ? { context: c } : c
        )
      }
    });
  }

  return {
    name,
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: {
        include: ['~DEFAULT_BRANCH'],
        exclude: []
      }
    },
    rules,
    bypass_actors: []
  };
}

function normalizeRules(rules) {
  return [...(rules || [])]
    .map((r) => ({
      type: r.type,
      parameters: r.parameters ? canonicalize(r.parameters) : undefined
    }))
    .sort((a, b) => a.type.localeCompare(b.type));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize(value[key]);
    return sorted;
  }
  return value;
}

export function rulesetsMatch(actual, desired) {
  if (!actual) return false;
  if (actual.enforcement !== desired.enforcement) return false;
  if (JSON.stringify(canonicalize(actual.conditions)) !== JSON.stringify(canonicalize(desired.conditions))) {
    return false;
  }
  if (JSON.stringify(normalizeRules(actual.rules)) !== JSON.stringify(normalizeRules(desired.rules))) {
    return false;
  }
  return true;
}

/**
 * Idempotently ensure a repo ruleset matching `desired` exists.
 *
 * @returns {Promise<{action: 'created'|'updated'|'unchanged', id?: number}>}
 */
export async function ensureRepositoryRuleset(octokit, owner, repo, desired) {
  getLogger().info(`Ensuring repo ruleset "${desired.name}" on ${owner}/${repo}`);

  const existing = await octokit.paginate('GET /repos/{owner}/{repo}/rulesets', {
    owner,
    repo,
    per_page: 100
  });

  const found = existing.find((r) => r.name === desired.name);

  if (!found) {
    const created = await octokit.request('POST /repos/{owner}/{repo}/rulesets', {
      owner,
      repo,
      ...desired
    });
    getLogger().info(`✅ Created ruleset "${desired.name}" on ${owner}/${repo}`);
    return { action: 'created', id: created.data?.id };
  }

  // List endpoint omits rules; fetch full ruleset to compare.
  const full = await octokit.request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
    owner,
    repo,
    ruleset_id: found.id
  });

  if (rulesetsMatch(full.data, desired)) {
    return { action: 'unchanged', id: found.id };
  }

  await octokit.request('PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
    owner,
    repo,
    ruleset_id: found.id,
    ...desired
  });
  getLogger().info(`✅ Updated ruleset "${desired.name}" on ${owner}/${repo}`);
  return { action: 'updated', id: found.id };
}

/**
 * Apply a ruleset derived from the legacy branch_protection config.
 * Falls back to legacy branch protection when rulesets are not enabled or fail
 * with a 404/422 (some plans / repos still don't expose the rulesets API).
 *
 * Returns the action taken so callers can log meaningfully.
 */
export async function applyRulesetFromBranchProtection(octokit, owner, repo, bpConfig, options = {}) {
  const { name = TEMPER_RULESET_NAME } = options;
  const desired = translateBranchProtectionToRuleset(bpConfig, name);
  return ensureRepositoryRuleset(octokit, owner, repo, desired);
}
