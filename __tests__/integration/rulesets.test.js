import {
  ensureRepositoryRuleset,
  translateBranchProtectionToRuleset,
  rulesetsMatch,
  applyRulesetFromBranchProtection,
  TEMPER_RULESET_NAME
} from '../../src/rulesets.js';

function createMockOctokit({ existing = [], full } = {}) {
  return {
    paginate: jest.fn().mockResolvedValue(existing),
    request: jest.fn().mockImplementation((route) => {
      if (route.startsWith('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}')) {
        return Promise.resolve({ data: full });
      }
      if (route.startsWith('POST /repos/{owner}/{repo}/rulesets')) {
        return Promise.resolve({ status: 201, data: { id: 999 } });
      }
      if (route.startsWith('PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}')) {
        return Promise.resolve({ status: 200, data: { id: full?.id } });
      }
      return Promise.resolve({ status: 200, data: {} });
    })
  };
}

describe('translateBranchProtectionToRuleset', () => {
  it('emits required_signatures rule when require_signed_commits is true', () => {
    const r = translateBranchProtectionToRuleset({ require_signed_commits: true });
    expect(r.rules.find((x) => x.type === 'required_signatures')).toBeDefined();
  });

  it('emits non_fast_forward rule by default (allow_force_pushes off)', () => {
    const r = translateBranchProtectionToRuleset({});
    expect(r.rules.find((x) => x.type === 'non_fast_forward')).toBeDefined();
  });

  it('omits deletion rule when allow_deletions is true', () => {
    const r = translateBranchProtectionToRuleset({ allow_deletions: true });
    expect(r.rules.find((x) => x.type === 'deletion')).toBeUndefined();
  });

  it('emits pull_request rule with mapped review parameters', () => {
    const r = translateBranchProtectionToRuleset({
      required_pull_request_reviews: {
        required_approving_review_count: 2,
        dismiss_stale_reviews: true,
        require_code_owner_reviews: true,
        require_last_push_approval: false
      },
      required_conversation_resolution: true
    });
    const pr = r.rules.find((x) => x.type === 'pull_request');
    expect(pr.parameters.required_approving_review_count).toBe(2);
    expect(pr.parameters.dismiss_stale_reviews_on_push).toBe(true);
    expect(pr.parameters.require_code_owner_review).toBe(true);
    expect(pr.parameters.required_review_thread_resolution).toBe(true);
  });

  it('emits required_status_checks with strict policy and contexts', () => {
    const r = translateBranchProtectionToRuleset({
      required_status_checks: { strict: true, contexts: ['ci/build', 'ci/test'] }
    });
    const checks = r.rules.find((x) => x.type === 'required_status_checks');
    expect(checks.parameters.strict_required_status_checks_policy).toBe(true);
    expect(checks.parameters.required_status_checks).toEqual([
      { context: 'ci/build' },
      { context: 'ci/test' }
    ]);
  });

  it('targets ~DEFAULT_BRANCH so it applies to empty repos', () => {
    const r = translateBranchProtectionToRuleset({});
    expect(r.conditions.ref_name.include).toEqual(['~DEFAULT_BRANCH']);
    expect(r.target).toBe('branch');
    expect(r.enforcement).toBe('active');
  });

  it('uses the canonical name when none provided', () => {
    const r = translateBranchProtectionToRuleset({});
    expect(r.name).toBe(TEMPER_RULESET_NAME);
  });
});

describe('rulesetsMatch', () => {
  it('returns true for identical rulesets', () => {
    const a = translateBranchProtectionToRuleset({ require_signed_commits: true });
    const b = translateBranchProtectionToRuleset({ require_signed_commits: true });
    expect(rulesetsMatch(a, b)).toBe(true);
  });

  it('returns false when enforcement differs', () => {
    const a = translateBranchProtectionToRuleset({});
    const b = { ...translateBranchProtectionToRuleset({}), enforcement: 'disabled' };
    expect(rulesetsMatch(a, b)).toBe(false);
  });

  it('returns false when rules differ', () => {
    const a = translateBranchProtectionToRuleset({ require_signed_commits: true });
    const b = translateBranchProtectionToRuleset({ require_signed_commits: false });
    expect(rulesetsMatch(a, b)).toBe(false);
  });

  it('returns true even if rules are in different order', () => {
    const a = translateBranchProtectionToRuleset({ require_signed_commits: true });
    const b = {
      ...a,
      rules: [...a.rules].reverse()
    };
    expect(rulesetsMatch(a, b)).toBe(true);
  });

  it('returns false when actual is undefined', () => {
    expect(rulesetsMatch(undefined, translateBranchProtectionToRuleset({}))).toBe(false);
  });
});

describe('ensureRepositoryRuleset', () => {
  it('creates a new ruleset when none exists', async () => {
    const octokit = createMockOctokit({ existing: [] });
    const desired = translateBranchProtectionToRuleset({ require_signed_commits: true });
    const result = await ensureRepositoryRuleset(octokit, 'o', 'r', desired);
    expect(result.action).toBe('created');
    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/rulesets',
      expect.objectContaining({ owner: 'o', repo: 'r', name: desired.name })
    );
  });

  it('leaves an unchanged ruleset alone', async () => {
    const desired = translateBranchProtectionToRuleset({});
    const octokit = createMockOctokit({
      existing: [{ id: 7, name: desired.name }],
      full: { id: 7, ...desired }
    });
    const result = await ensureRepositoryRuleset(octokit, 'o', 'r', desired);
    expect(result.action).toBe('unchanged');
    expect(octokit.request).not.toHaveBeenCalledWith(
      expect.stringMatching(/^(POST|PUT)/),
      expect.anything()
    );
  });

  it('updates a drifted ruleset', async () => {
    const desired = translateBranchProtectionToRuleset({ require_signed_commits: true });
    const driftedFull = {
      id: 7,
      ...translateBranchProtectionToRuleset({ require_signed_commits: false })
    };
    const octokit = createMockOctokit({
      existing: [{ id: 7, name: desired.name }],
      full: driftedFull
    });
    const result = await ensureRepositoryRuleset(octokit, 'o', 'r', desired);
    expect(result.action).toBe('updated');
    expect(octokit.request).toHaveBeenCalledWith(
      'PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}',
      expect.objectContaining({ ruleset_id: 7 })
    );
  });
});

describe('applyRulesetFromBranchProtection', () => {
  it('translates and ensures', async () => {
    const octokit = createMockOctokit({ existing: [] });
    const result = await applyRulesetFromBranchProtection(
      octokit,
      'o',
      'r',
      { require_signed_commits: true }
    );
    expect(result.action).toBe('created');
  });
});
