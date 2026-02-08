const { checkOrganizationMembership, synchronizeAllRepositories } = require('../../src/organization');
const { _setConfigForTesting } = require('../../src/config');

function createMockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ status: 204, data: {} }),
    paginate: jest.fn().mockResolvedValue([])
  };
}

describe('organization', () => {
  let octokit;
  beforeEach(() => {
    octokit = createMockOctokit();
    _setConfigForTesting({
      settings: { merge: { allow_rebase_merge: true, allow_merge_commit: false, allow_squash_merge: false, delete_branch_on_merge: true } }
    });
  });
  afterEach(() => { _setConfigForTesting({}); });

  describe('checkOrganizationMembership', () => {
    it('returns true for 204 response', async () => {
      octokit.request.mockResolvedValue({ status: 204 });
      const result = await checkOrganizationMembership(octokit, 'org', 'user');
      expect(result).toBe(true);
    });

    it('returns false for 404', async () => {
      octokit.request.mockRejectedValue({ status: 404 });
      const result = await checkOrganizationMembership(octokit, 'org', 'user');
      expect(result).toBe(false);
    });

    it('returns false for other errors', async () => {
      octokit.request.mockRejectedValue(new Error('Network error'));
      const result = await checkOrganizationMembership(octokit, 'org', 'user');
      expect(result).toBe(false);
    });

    it('calls the correct API endpoint', async () => {
      octokit.request.mockResolvedValue({ status: 204 });
      await checkOrganizationMembership(octokit, 'my-org', 'my-user');
      expect(octokit.request).toHaveBeenCalledWith(
        'GET /orgs/{org}/members/{username}',
        { org: 'my-org', username: 'my-user' }
      );
    });
  });

  describe('synchronizeAllRepositories', () => {
    it('processes non-archived repos', async () => {
      octokit.paginate.mockResolvedValue([
        { name: 'repo1', full_name: 'org/repo1', owner: { login: 'org' }, archived: false, default_branch: 'main', fork: false },
        { name: 'repo2', full_name: 'org/repo2', owner: { login: 'org' }, archived: true, default_branch: 'main', fork: false }
      ]);

      const result = await synchronizeAllRepositories(octokit, 'org');
      expect(result.success).toBe(true);
      expect(result.repositoriesProcessed).toBe(2);
    });

    it('skips archived repos but still counts them', async () => {
      octokit.paginate.mockResolvedValue([
        { name: 'archived-repo', full_name: 'org/archived-repo', owner: { login: 'org' }, archived: true, default_branch: 'main', fork: false }
      ]);

      const result = await synchronizeAllRepositories(octokit, 'org');
      expect(result.success).toBe(true);
      expect(result.repositoriesProcessed).toBe(1);
      // PATCH should not be called since archived repo is skipped
      expect(octokit.request).not.toHaveBeenCalledWith(
        'PATCH /repos/{owner}/{repo}',
        expect.anything()
      );
    });

    it('handles empty org', async () => {
      octokit.paginate.mockResolvedValue([]);
      const result = await synchronizeAllRepositories(octokit, 'empty-org');
      expect(result.success).toBe(true);
      expect(result.repositoriesProcessed).toBe(0);
    });

    it('returns error on paginate failure', async () => {
      octokit.paginate.mockRejectedValue(new Error('Paginate failed'));
      const result = await synchronizeAllRepositories(octokit, 'org');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Paginate failed');
    });
  });
});
