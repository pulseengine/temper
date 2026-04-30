import { synchronizeIssueLabels, ensureLabelsExist } from '../../src/labels.js';

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

  it('removes labels not in target when mode is replace', async () => {
    octokit.paginate.mockResolvedValue([{ name: 'old-label', color: 'fff', description: '' }]);
    const target = [];

    await synchronizeIssueLabels(octokit, 'owner', 'repo', target, { mode: 'replace' });

    expect(octokit.request).toHaveBeenCalledWith(
      'DELETE /repos/{owner}/{repo}/labels/{name}',
      expect.objectContaining({ name: 'old-label' })
    );
  });

  it('does NOT remove labels in default merge mode (Bug #1 fix)', async () => {
    octokit.paginate.mockResolvedValue([{ name: 'priority/p0', color: 'fff', description: 'user-created' }]);
    const target = [];

    await synchronizeIssueLabels(octokit, 'owner', 'repo', target);

    expect(octokit.request).not.toHaveBeenCalledWith(
      'DELETE /repos/{owner}/{repo}/labels/{name}',
      expect.anything()
    );
  });

  it('rejects an invalid mode value', async () => {
    octokit.paginate.mockResolvedValue([]);
    await expect(
      synchronizeIssueLabels(octokit, 'owner', 'repo', [], { mode: 'destroy' })
    ).rejects.toThrow(/invalid mode/i);
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

  it('handles create, update, and delete in one pass (replace mode)', async () => {
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

    await synchronizeIssueLabels(octokit, 'owner', 'repo', target, { mode: 'replace' });

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

describe('ensureLabelsExist', () => {
  let octokit;
  beforeEach(() => { octokit = createMockOctokit(); });

  it('creates missing labels with DEPENDABOT_LABEL_DEFAULTS', async () => {
    octokit.paginate.mockResolvedValue([]);

    await ensureLabelsExist(octokit, 'owner', 'repo', ['dependencies']);

    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/labels',
      expect.objectContaining({ name: 'dependencies', color: '0366d6', description: 'Dependency updates' })
    );
  });

  it('uses fallback defaults for unknown labels', async () => {
    octokit.paginate.mockResolvedValue([]);

    await ensureLabelsExist(octokit, 'owner', 'repo', ['custom-label']);

    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/labels',
      expect.objectContaining({ name: 'custom-label', color: 'ededed', description: 'Automated label' })
    );
  });

  it('skips labels that already exist', async () => {
    octokit.paginate.mockResolvedValue([{ name: 'dependencies', color: '0366d6', description: 'Deps' }]);

    await ensureLabelsExist(octokit, 'owner', 'repo', ['dependencies']);

    expect(octokit.request).not.toHaveBeenCalled();
  });

  it('never updates or deletes existing labels', async () => {
    octokit.paginate.mockResolvedValue([
      { name: 'dependencies', color: 'ffffff', description: 'Old' },
      { name: 'extra', color: 'aaa', description: 'Extra' }
    ]);

    await ensureLabelsExist(octokit, 'owner', 'repo', ['dependencies']);

    expect(octokit.request).not.toHaveBeenCalledWith(
      'PATCH /repos/{owner}/{repo}/labels/{name}',
      expect.anything()
    );
    expect(octokit.request).not.toHaveBeenCalledWith(
      'DELETE /repos/{owner}/{repo}/labels/{name}',
      expect.anything()
    );
  });

  it('creates only missing labels from a mixed set', async () => {
    octokit.paginate.mockResolvedValue([{ name: 'dependencies', color: '0366d6', description: 'Deps' }]);

    await ensureLabelsExist(octokit, 'owner', 'repo', ['dependencies', 'automation']);

    expect(octokit.request).toHaveBeenCalledTimes(1);
    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/labels',
      expect.objectContaining({ name: 'automation', color: '0e8a16' })
    );
  });

  it('handles empty label list', async () => {
    octokit.paginate.mockResolvedValue([{ name: 'existing' }]);

    await ensureLabelsExist(octokit, 'owner', 'repo', []);

    expect(octokit.request).not.toHaveBeenCalled();
  });
});
