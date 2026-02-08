import { configureRepository } from '../../src/repository.js';
import { _setConfigForTesting } from '../../src/config.js';

function createMockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ status: 200, data: {} }),
    paginate: jest.fn().mockResolvedValue([])
  };
}

describe('configureRepository', () => {
  let octokit;
  beforeEach(() => {
    octokit = createMockOctokit();
    _setConfigForTesting({
      settings: { merge: { allow_rebase_merge: true, allow_merge_commit: false, allow_squash_merge: false, delete_branch_on_merge: true } }
    });
  });
  afterEach(() => { _setConfigForTesting({}); });

  it('applies merge settings', async () => {
    const result = await configureRepository(octokit, 'owner', 'repo');

    expect(result.success).toBe(true);
    expect(octokit.request).toHaveBeenCalledWith(
      'PATCH /repos/{owner}/{repo}',
      expect.objectContaining({ owner: 'owner', repo: 'repo', allow_rebase_merge: true })
    );
  });

  it('applies branch protection when configured', async () => {
    _setConfigForTesting({
      settings: { merge: { allow_rebase_merge: true, allow_merge_commit: false, allow_squash_merge: false, delete_branch_on_merge: true } },
      branch_protection: { default: { enforce_admins: true } }
    });

    const result = await configureRepository(octokit, 'owner', 'repo');

    expect(result.success).toBe(true);
    expect(octokit.request).toHaveBeenCalledWith(
      'PUT /repos/{owner}/{repo}/branches/{branch}/protection',
      expect.objectContaining({ branch: 'main' })
    );
  });

  it('synchronizes labels when configured', async () => {
    _setConfigForTesting({
      settings: { merge: { allow_rebase_merge: true, allow_merge_commit: false, allow_squash_merge: false, delete_branch_on_merge: true } },
      issue_labels: [{ name: 'bug', color: 'd73a4a', description: 'Bug' }]
    });

    const result = await configureRepository(octokit, 'owner', 'repo');

    expect(result.success).toBe(true);
    // paginate should be called for label sync (GET /repos/{owner}/{repo}/labels)
    expect(octokit.paginate).toHaveBeenCalled();
  });

  it('accepts a repo object as input', async () => {
    const repoObj = { name: 'my-repo', owner: { login: 'my-org' }, default_branch: 'develop', fork: false };
    const result = await configureRepository(octokit, repoObj);

    expect(result.success).toBe(true);
    expect(octokit.request).toHaveBeenCalledWith(
      'PATCH /repos/{owner}/{repo}',
      expect.objectContaining({ owner: 'my-org', repo: 'my-repo' })
    );
  });

  it('returns error on failure', async () => {
    octokit.request.mockRejectedValue(new Error('API error'));
    const result = await configureRepository(octokit, 'owner', 'repo');
    expect(result.success).toBe(false);
    expect(result.error).toBe('API error');
  });

  it('applies dependabot config when configured', async () => {
    _setConfigForTesting({
      settings: { merge: { allow_rebase_merge: true, allow_merge_commit: false, allow_squash_merge: false, delete_branch_on_merge: true } },
      dependabot: { version: 2, updates: [{ labels: ['dependencies'] }] }
    });

    // Call sequence:
    // 1. PATCH repo settings
    // 2. POST label 'dependencies' (synchronizeIssueLabels - dependabot labels are auto-added)
    // 3. GET dependabot.yml (checkExistingDependabotConfig) -> 404
    // 4. GET existing file in upsertRepoFile -> 404
    // 5. PUT dependabot file
    octokit.request
      .mockResolvedValueOnce({ status: 200, data: {} })  // 1: PATCH repo settings
      .mockResolvedValueOnce({ status: 200, data: {} })  // 2: POST label
      .mockRejectedValueOnce({ status: 404 })            // 3: GET dependabot.yml -> 404
      .mockRejectedValueOnce({ status: 404 })            // 4: upsertRepoFile GET -> 404
      .mockResolvedValueOnce({ status: 200, data: {} }); // 5: upsertRepoFile PUT

    const result = await configureRepository(octokit, 'owner', 'repo');
    expect(result.success).toBe(true);
  });
});
