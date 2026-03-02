import {
  getMergeSettings,
  getBranchProtectionConfig,
  mergePullRequestRules,
  getRequiredSignaturesFlag,
  getDependabotLabels,
  getTargetIssueLabels,
  deepMerge,
  _setConfigForTesting,
  DEFAULT_MERGE_SETTINGS
} from '../../src/config.js';

describe('deepMerge', () => {
  it('merges top-level keys from both objects', () => {
    const result = deepMerge({ a: 1 }, { b: 2 });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('overrides primitive values from source', () => {
    const result = deepMerge({ a: 1, b: 'old' }, { b: 'new' });
    expect(result).toEqual({ a: 1, b: 'new' });
  });

  it('recursively merges nested objects', () => {
    const result = deepMerge(
      { nested: { a: 1, b: 2 } },
      { nested: { b: 3, c: 4 } }
    );
    expect(result).toEqual({ nested: { a: 1, b: 3, c: 4 } });
  });

  it('replaces arrays entirely from source', () => {
    const result = deepMerge(
      { items: [1, 2, 3] },
      { items: [4, 5] }
    );
    expect(result).toEqual({ items: [4, 5] });
  });

  it('allows null to override a value', () => {
    const result = deepMerge({ a: { b: 1 } }, { a: null });
    expect(result).toEqual({ a: null });
  });
});

describe('config', () => {
  afterEach(() => {
    // Reset to real config after each test
    _setConfigForTesting({});
  });

  describe('getMergeSettings', () => {
    it('returns TARGET_SETTINGS for non-fork', () => {
      _setConfigForTesting({
        settings: { merge: { allow_rebase_merge: true, allow_merge_commit: false, allow_squash_merge: false, delete_branch_on_merge: true } }
      });
      const result = getMergeSettings({ fork: false });
      expect(result.allow_rebase_merge).toBe(true);
      expect(result.allow_merge_commit).toBe(false);
    });

    it('merges fork overrides for forks', () => {
      _setConfigForTesting({
        settings: { merge: { allow_rebase_merge: true, allow_merge_commit: false, allow_squash_merge: false, delete_branch_on_merge: true } },
        forks: { merge: { allow_merge_commit: true } }
      });
      const result = getMergeSettings({ fork: true });
      expect(result.allow_merge_commit).toBe(true);
      expect(result.allow_rebase_merge).toBe(true);
    });

    it('uses defaults when no config', () => {
      _setConfigForTesting({});
      const result = getMergeSettings({ fork: false });
      expect(result).toEqual(DEFAULT_MERGE_SETTINGS);
    });
  });

  describe('getBranchProtectionConfig', () => {
    it('returns config for default branch', () => {
      _setConfigForTesting({
        branch_protection: {
          default: { enforce_admins: true },
          main: { enforce_admins: false }
        }
      });
      const result = getBranchProtectionConfig({ default_branch: 'main' });
      expect(result.enforce_admins).toBe(false);
    });

    it('falls back to default key', () => {
      _setConfigForTesting({
        branch_protection: {
          default: { enforce_admins: true }
        }
      });
      const result = getBranchProtectionConfig({ default_branch: 'develop' });
      expect(result.enforce_admins).toBe(true);
    });

    it('applies fork overrides', () => {
      _setConfigForTesting({
        branch_protection: {
          default: { enforce_admins: true },
          fork_overrides: { enforce_admins: false }
        }
      });
      const result = getBranchProtectionConfig({ default_branch: 'main', fork: true });
      expect(result.enforce_admins).toBe(false);
    });
  });

  describe('mergePullRequestRules', () => {
    it('returns unchanged config when no PR rules', () => {
      _setConfigForTesting({});
      const input = { enforce_admins: true };
      expect(mergePullRequestRules(input)).toEqual(input);
    });

    it('merges PR review rules', () => {
      _setConfigForTesting({
        pull_request_rules: {
          required_approving_reviews: 2,
          dismiss_stale_reviews: true,
          require_code_owner_reviews: true,
          require_last_push_approval: false,
          required_status_checks: ['ci']
        }
      });
      const result = mergePullRequestRules({ required_pull_request_reviews: {}, required_status_checks: {} });
      expect(result.required_pull_request_reviews.required_approving_review_count).toBe(2);
      expect(result.required_status_checks.contexts).toEqual(['ci']);
    });
  });

  describe('getRequiredSignaturesFlag', () => {
    it('returns require_signed_commits when set', () => {
      expect(getRequiredSignaturesFlag({ require_signed_commits: true })).toBe(true);
      expect(getRequiredSignaturesFlag({ require_signed_commits: false })).toBe(false);
    });

    it('falls back to required_signatures', () => {
      expect(getRequiredSignaturesFlag({ required_signatures: true })).toBe(true);
    });

    it('returns null when neither set', () => {
      expect(getRequiredSignaturesFlag({})).toBeNull();
      expect(getRequiredSignaturesFlag()).toBeNull();
    });
  });

  describe('getDependabotLabels', () => {
    it('extracts unique labels from updates', () => {
      const result = getDependabotLabels({
        updates: [
          { labels: ['a', 'b'] },
          { labels: ['b', 'c'] }
        ]
      });
      expect(result).toEqual(['a', 'b', 'c']);
    });

    it('returns empty array for missing config', () => {
      expect(getDependabotLabels(null)).toEqual([]);
      expect(getDependabotLabels({})).toEqual([]);
      expect(getDependabotLabels({ updates: 'not-array' })).toEqual([]);
    });
  });

  describe('getTargetIssueLabels', () => {
    it('merges issue_labels with dependabot labels', () => {
      _setConfigForTesting({
        issue_labels: [{ name: 'bug', color: 'red', description: 'Bug' }],
        dependabot: { updates: [{ labels: ['dependencies'] }] }
      });
      const result = getTargetIssueLabels();
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('bug');
      expect(result[1].name).toBe('dependencies');
      expect(result[1].color).toBe('0366d6');
    });

    it('does not duplicate existing labels', () => {
      _setConfigForTesting({
        issue_labels: [{ name: 'dependencies', color: 'blue', description: 'Deps' }],
        dependabot: { updates: [{ labels: ['dependencies'] }] }
      });
      const result = getTargetIssueLabels();
      expect(result).toHaveLength(1);
      expect(result[0].color).toBe('blue');
    });

    it('returns empty array with no config', () => {
      _setConfigForTesting({});
      expect(getTargetIssueLabels()).toEqual([]);
    });

    it('includes labels from dependabot_generation.default_labels', () => {
      _setConfigForTesting({
        dependabot_generation: { default_labels: ['dependencies', 'github-actions'] }
      });
      const result = getTargetIssueLabels();
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('dependencies');
      expect(result[0].color).toBe('0366d6');
      expect(result[1].name).toBe('github-actions');
      expect(result[1].color).toBe('ededed');
    });

    it('deduplicates labels from dependabot and dependabot_generation', () => {
      _setConfigForTesting({
        dependabot: { updates: [{ labels: ['dependencies'] }] },
        dependabot_generation: { default_labels: ['dependencies', 'automation'] }
      });
      const result = getTargetIssueLabels();
      expect(result).toHaveLength(2);
      expect(result.map((l) => l.name)).toEqual(['dependencies', 'automation']);
    });

    it('deduplicates against issue_labels too', () => {
      _setConfigForTesting({
        issue_labels: [{ name: 'dependencies', color: 'custom', description: 'Custom' }],
        dependabot_generation: { default_labels: ['dependencies'] }
      });
      const result = getTargetIssueLabels();
      expect(result).toHaveLength(1);
      expect(result[0].color).toBe('custom');
    });
  });
});
