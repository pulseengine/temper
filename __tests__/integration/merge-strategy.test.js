const { handleSignedCommitMerge, checkPRMergeStrategy } = require('../../src/merge-strategy');
const { _setConfigForTesting } = require('../../src/config');

function createMockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ status: 200, data: {} })
  };
}

describe('merge-strategy', () => {
  let octokit;
  beforeEach(() => { octokit = createMockOctokit(); });
  afterEach(() => { _setConfigForTesting({}); });

  describe('handleSignedCommitMerge', () => {
    it('returns disabled when config is off', async () => {
      _setConfigForTesting({ signed_commit_strategy: { allow_merge_commits_for_signed: false } });
      const result = await handleSignedCommitMerge(octokit, 'o', 'r', 1);
      expect(result.action).toBe('disabled');
    });

    it('returns disabled when no signed_commit_strategy config', async () => {
      _setConfigForTesting({});
      const result = await handleSignedCommitMerge(octokit, 'o', 'r', 1);
      expect(result.action).toBe('disabled');
    });

    it('returns not_applicable for non-protected branches', async () => {
      _setConfigForTesting({
        signed_commit_strategy: {
          allow_merge_commits_for_signed: true,
          protected_branches: ['main']
        }
      });

      octokit.request
        .mockResolvedValueOnce({ data: { base: { ref: 'develop' } } }) // PR details
        .mockResolvedValueOnce({ data: [{ commit: { verification: { verified: true } } }] }); // commits

      const result = await handleSignedCommitMerge(octokit, 'o', 'r', 1);
      expect(result.action).toBe('not_applicable');
    });

    it('temporarily allows merge commits for signed PRs', async () => {
      _setConfigForTesting({
        signed_commit_strategy: {
          allow_merge_commits_for_signed: true,
          temporary_rule_timeout: 100,
          protected_branches: ['main']
        }
      });

      octokit.request
        .mockResolvedValueOnce({ data: { base: { ref: 'main' } } }) // PR details
        .mockResolvedValueOnce({ data: [{ commit: { verification: { verified: true } } }] }) // commits
        .mockResolvedValueOnce({ data: { allow_merge_commit: false } }) // repo settings
        .mockResolvedValueOnce({ data: {} }); // PATCH to allow merge commits

      const result = await handleSignedCommitMerge(octokit, 'o', 'r', 1);
      expect(result.action).toBe('temporarily_allowed_merge_commits');
    });

    it('returns no_change_needed when merge commits already allowed', async () => {
      _setConfigForTesting({
        signed_commit_strategy: {
          allow_merge_commits_for_signed: true,
          protected_branches: ['main']
        }
      });

      octokit.request
        .mockResolvedValueOnce({ data: { base: { ref: 'main' } } }) // PR details
        .mockResolvedValueOnce({ data: [{ commit: { verification: { verified: true } } }] }) // commits
        .mockResolvedValueOnce({ data: { allow_merge_commit: true } }); // repo settings

      const result = await handleSignedCommitMerge(octokit, 'o', 'r', 1);
      expect(result.action).toBe('no_change_needed');
    });

    it('returns no_signed_commits when PR has no verified commits', async () => {
      _setConfigForTesting({
        signed_commit_strategy: {
          allow_merge_commits_for_signed: true,
          protected_branches: ['main']
        }
      });

      octokit.request
        .mockResolvedValueOnce({ data: { base: { ref: 'main' } } }) // PR details
        .mockResolvedValueOnce({ data: [{ commit: { verification: { verified: false } } }] }); // commits

      const result = await handleSignedCommitMerge(octokit, 'o', 'r', 1);
      expect(result.action).toBe('no_signed_commits');
    });

    it('returns error on API failure', async () => {
      _setConfigForTesting({
        signed_commit_strategy: {
          allow_merge_commits_for_signed: true,
          protected_branches: ['main']
        }
      });

      octokit.request.mockRejectedValue(new Error('API failure'));

      const result = await handleSignedCommitMerge(octokit, 'o', 'r', 1);
      expect(result.success).toBe(false);
      expect(result.error).toBe('API failure');
    });
  });

  describe('checkPRMergeStrategy', () => {
    it('returns PR merge strategy info', async () => {
      octokit.request
        .mockResolvedValueOnce({ data: { title: 'Test PR', base: { ref: 'main' } } })
        .mockResolvedValueOnce({ data: { allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: true } })
        .mockResolvedValueOnce({ data: [{ commit: { verification: { verified: true } } }] });

      const result = await checkPRMergeStrategy(octokit, 'o', 'r', 1);
      expect(result.prTitle).toBe('Test PR');
      expect(result.hasSignedCommits).toBe(true);
      expect(result.commitCount).toBe(1);
      expect(result.signedCommitCount).toBe(1);
    });

    it('returns merge strategy settings', async () => {
      octokit.request
        .mockResolvedValueOnce({ data: { title: 'PR', base: { ref: 'main' } } })
        .mockResolvedValueOnce({ data: { allow_merge_commit: false, allow_squash_merge: true, allow_rebase_merge: true } })
        .mockResolvedValueOnce({ data: [] });

      const result = await checkPRMergeStrategy(octokit, 'o', 'r', 1);
      expect(result.currentMergeStrategy.allowMergeCommit).toBe(false);
      expect(result.currentMergeStrategy.allowSquashMerge).toBe(true);
      expect(result.currentMergeStrategy.allowRebaseMerge).toBe(true);
      expect(result.hasSignedCommits).toBe(false);
      expect(result.commitCount).toBe(0);
    });

    it('returns error on failure', async () => {
      octokit.request.mockRejectedValue(new Error('Not found'));
      const result = await checkPRMergeStrategy(octokit, 'o', 'r', 999);
      expect(result.error).toBe('Not found');
    });
  });
});
