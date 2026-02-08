const { synchronizeIssueLabels } = require('../../src/labels');

function createMockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ status: 200, data: {} }),
    paginate: jest.fn().mockResolvedValue([])
  };
}

describe('synchronizeIssueLabels', () => {
  let octokit;
  beforeEach(() => { octokit = createMockOctokit(); });

  it('creates missing labels', async () => {
    octokit.paginate.mockResolvedValue([]);
    const target = [{ name: 'bug', color: 'red', description: 'Bug' }];

    await synchronizeIssueLabels(octokit, 'owner', 'repo', target);

    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/labels',
      expect.objectContaining({ name: 'bug', color: 'red' })
    );
  });

  it('updates labels with different color/description', async () => {
    octokit.paginate.mockResolvedValue([{ name: 'bug', color: 'blue', description: 'Old' }]);
    const target = [{ name: 'bug', color: 'red', description: 'New' }];

    await synchronizeIssueLabels(octokit, 'owner', 'repo', target);

    expect(octokit.request).toHaveBeenCalledWith(
      'PATCH /repos/{owner}/{repo}/labels/{name}',
      expect.objectContaining({ name: 'bug', color: 'red', description: 'New' })
    );
  });

  it('removes labels not in target', async () => {
    octokit.paginate.mockResolvedValue([{ name: 'old-label', color: 'fff', description: '' }]);
    const target = [];

    await synchronizeIssueLabels(octokit, 'owner', 'repo', target);

    expect(octokit.request).toHaveBeenCalledWith(
      'DELETE /repos/{owner}/{repo}/labels/{name}',
      expect.objectContaining({ name: 'old-label' })
    );
  });

  it('skips update when label matches', async () => {
    octokit.paginate.mockResolvedValue([{ name: 'bug', color: 'red', description: 'Bug' }]);
    const target = [{ name: 'bug', color: 'red', description: 'Bug' }];

    await synchronizeIssueLabels(octokit, 'owner', 'repo', target);

    expect(octokit.request).not.toHaveBeenCalledWith(
      'PATCH /repos/{owner}/{repo}/labels/{name}',
      expect.anything()
    );
  });

  it('does not delete labels that are in the target', async () => {
    octokit.paginate.mockResolvedValue([{ name: 'bug', color: 'red', description: 'Bug' }]);
    const target = [{ name: 'bug', color: 'red', description: 'Bug' }];

    await synchronizeIssueLabels(octokit, 'owner', 'repo', target);

    expect(octokit.request).not.toHaveBeenCalledWith(
      'DELETE /repos/{owner}/{repo}/labels/{name}',
      expect.anything()
    );
  });

  it('handles create, update, and delete in one pass', async () => {
    octokit.paginate.mockResolvedValue([
      { name: 'keep', color: 'aaa', description: 'Keep' },
      { name: 'update-me', color: 'old', description: 'Old desc' },
      { name: 'remove-me', color: 'bbb', description: 'Remove' }
    ]);
    const target = [
      { name: 'keep', color: 'aaa', description: 'Keep' },
      { name: 'update-me', color: 'new', description: 'New desc' },
      { name: 'create-me', color: 'ccc', description: 'Created' }
    ];

    await synchronizeIssueLabels(octokit, 'owner', 'repo', target);

    // Should not update 'keep' (unchanged)
    expect(octokit.request).not.toHaveBeenCalledWith(
      'PATCH /repos/{owner}/{repo}/labels/{name}',
      expect.objectContaining({ name: 'keep' })
    );
    // Should update 'update-me'
    expect(octokit.request).toHaveBeenCalledWith(
      'PATCH /repos/{owner}/{repo}/labels/{name}',
      expect.objectContaining({ name: 'update-me', color: 'new' })
    );
    // Should create 'create-me'
    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/labels',
      expect.objectContaining({ name: 'create-me' })
    );
    // Should delete 'remove-me'
    expect(octokit.request).toHaveBeenCalledWith(
      'DELETE /repos/{owner}/{repo}/labels/{name}',
      expect.objectContaining({ name: 'remove-me' })
    );
  });

  it('propagates errors', async () => {
    octokit.paginate.mockRejectedValue(new Error('API down'));
    await expect(
      synchronizeIssueLabels(octokit, 'owner', 'repo', [])
    ).rejects.toThrow('API down');
  });
});
