// jest.mock() calls are hoisted by babel above all other code, so factories
// must be self-contained. We import the mocked modules after the mock
// declarations and reference the mock functions through those imports.

jest.mock('../../src/logger.js', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { getLogger: () => mockLogger };
});

import { upsertRepoFile, createConfigurationPR } from '../../src/github-api.js';
import { _setConfigForTesting } from '../../src/config.js';
import { getLogger } from '../../src/logger.js';

function createMockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ status: 200, data: {} })
  };
}

describe('upsertRepoFile', () => {
  let octokit;

  beforeEach(() => {
    octokit = createMockOctokit();
    jest.clearAllMocks();
    octokit.request.mockResolvedValue({ status: 200, data: {} });
  });

  it('creates a new file when the file does not exist (404)', async () => {
    const error404 = new Error('Not Found');
    error404.status = 404;

    octokit.request
      .mockRejectedValueOnce(error404)                    // GET contents -> 404
      .mockResolvedValueOnce({ status: 201, data: {} });  // PUT contents

    await upsertRepoFile(octokit, 'owner', 'repo', 'README.md', 'Hello', 'Add README');

    // GET call should not include ref when branch is not provided
    expect(octokit.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/contents/{path}',
      { owner: 'owner', repo: 'repo', path: 'README.md' }
    );

    // PUT call should have content base64-encoded and sha undefined
    expect(octokit.request).toHaveBeenCalledWith(
      'PUT /repos/{owner}/{repo}/contents/{path}',
      {
        owner: 'owner',
        repo: 'repo',
        path: 'README.md',
        message: 'Add README',
        content: Buffer.from('Hello').toString('base64'),
        sha: undefined
      }
    );
  });

  it('updates an existing file with its sha', async () => {
    octokit.request
      .mockResolvedValueOnce({ status: 200, data: { sha: 'abc123' } })  // GET contents
      .mockResolvedValueOnce({ status: 200, data: {} });                 // PUT contents

    await upsertRepoFile(octokit, 'owner', 'repo', 'README.md', 'Updated', 'Update README');

    expect(octokit.request).toHaveBeenCalledWith(
      'PUT /repos/{owner}/{repo}/contents/{path}',
      expect.objectContaining({ sha: 'abc123' })
    );
  });

  it('includes ref parameter in GET when branch is provided', async () => {
    const error404 = new Error('Not Found');
    error404.status = 404;

    octokit.request
      .mockRejectedValueOnce(error404)
      .mockResolvedValueOnce({ status: 201, data: {} });

    await upsertRepoFile(octokit, 'owner', 'repo', 'file.txt', 'content', 'msg', 'feature-branch');

    expect(octokit.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/contents/{path}',
      { owner: 'owner', repo: 'repo', path: 'file.txt', ref: 'feature-branch' }
    );
  });

  it('includes branch parameter in PUT when branch is provided', async () => {
    const error404 = new Error('Not Found');
    error404.status = 404;

    octokit.request
      .mockRejectedValueOnce(error404)
      .mockResolvedValueOnce({ status: 201, data: {} });

    await upsertRepoFile(octokit, 'owner', 'repo', 'file.txt', 'content', 'msg', 'feature-branch');

    expect(octokit.request).toHaveBeenCalledWith(
      'PUT /repos/{owner}/{repo}/contents/{path}',
      expect.objectContaining({ branch: 'feature-branch' })
    );
  });

  it('updates existing file on a specific branch', async () => {
    octokit.request
      .mockResolvedValueOnce({ status: 200, data: { sha: 'existing-sha' } })
      .mockResolvedValueOnce({ status: 200, data: {} });

    await upsertRepoFile(octokit, 'owner', 'repo', 'file.txt', 'new content', 'update', 'my-branch');

    // GET should include ref
    expect(octokit.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/contents/{path}',
      { owner: 'owner', repo: 'repo', path: 'file.txt', ref: 'my-branch' }
    );

    // PUT should include sha and branch
    expect(octokit.request).toHaveBeenCalledWith(
      'PUT /repos/{owner}/{repo}/contents/{path}',
      {
        owner: 'owner',
        repo: 'repo',
        path: 'file.txt',
        message: 'update',
        content: Buffer.from('new content').toString('base64'),
        sha: 'existing-sha',
        branch: 'my-branch'
      }
    );
  });

  it('does not set sha when GET returns an array (directory listing)', async () => {
    octokit.request
      .mockResolvedValueOnce({ status: 200, data: [{ name: 'a.txt' }, { name: 'b.txt' }] })
      .mockResolvedValueOnce({ status: 200, data: {} });

    await upsertRepoFile(octokit, 'owner', 'repo', 'dir/', 'content', 'msg');

    expect(octokit.request).toHaveBeenCalledWith(
      'PUT /repos/{owner}/{repo}/contents/{path}',
      expect.objectContaining({ sha: undefined })
    );
  });

  it('rethrows non-404 errors from GET', async () => {
    const error403 = new Error('Forbidden');
    error403.status = 403;

    octokit.request.mockRejectedValueOnce(error403);

    await expect(
      upsertRepoFile(octokit, 'owner', 'repo', 'file.txt', 'content', 'msg')
    ).rejects.toThrow('Forbidden');

    // PUT should not have been called
    expect(octokit.request).toHaveBeenCalledTimes(1);
  });

  it('rethrows errors without a status property', async () => {
    const genericError = new Error('Network error');

    octokit.request.mockRejectedValueOnce(genericError);

    await expect(
      upsertRepoFile(octokit, 'owner', 'repo', 'file.txt', 'content', 'msg')
    ).rejects.toThrow('Network error');
  });

  it('rethrows errors from PUT', async () => {
    const error404 = new Error('Not Found');
    error404.status = 404;

    octokit.request
      .mockRejectedValueOnce(error404)                          // GET -> 404
      .mockRejectedValueOnce(new Error('PUT failed'));           // PUT -> error

    await expect(
      upsertRepoFile(octokit, 'owner', 'repo', 'file.txt', 'content', 'msg')
    ).rejects.toThrow('PUT failed');
  });

  it('correctly base64 encodes content with special characters', async () => {
    const error404 = new Error('Not Found');
    error404.status = 404;

    octokit.request
      .mockRejectedValueOnce(error404)
      .mockResolvedValueOnce({ status: 201, data: {} });

    const specialContent = 'Line 1\nLine 2\n\tTabbed\nUnicode: \u00e9\u00e0\u00fc';
    await upsertRepoFile(octokit, 'owner', 'repo', 'file.txt', specialContent, 'msg');

    expect(octokit.request).toHaveBeenCalledWith(
      'PUT /repos/{owner}/{repo}/contents/{path}',
      expect.objectContaining({
        content: Buffer.from(specialContent).toString('base64')
      })
    );
  });

  it('does not include branch in GET or PUT when branch is undefined', async () => {
    octokit.request
      .mockResolvedValueOnce({ status: 200, data: { sha: 'sha1' } })
      .mockResolvedValueOnce({ status: 200, data: {} });

    await upsertRepoFile(octokit, 'owner', 'repo', 'file.txt', 'content', 'msg', undefined);

    const getCall = octokit.request.mock.calls[0];
    expect(getCall[1]).not.toHaveProperty('ref');

    const putCall = octokit.request.mock.calls[1];
    expect(putCall[1]).not.toHaveProperty('branch');
  });

  it('does not include branch in GET or PUT when branch is empty string', async () => {
    octokit.request
      .mockResolvedValueOnce({ status: 200, data: { sha: 'sha1' } })
      .mockResolvedValueOnce({ status: 200, data: {} });

    await upsertRepoFile(octokit, 'owner', 'repo', 'file.txt', 'content', 'msg', '');

    const getCall = octokit.request.mock.calls[0];
    expect(getCall[1]).not.toHaveProperty('ref');

    const putCall = octokit.request.mock.calls[1];
    expect(putCall[1]).not.toHaveProperty('branch');
  });
});

describe('createConfigurationPR', () => {
  let octokit;

  beforeEach(() => {
    octokit = createMockOctokit();
    jest.clearAllMocks();
    octokit.request.mockResolvedValue({ status: 200, data: {} });
    _setConfigForTesting({});
  });

  afterEach(() => {
    _setConfigForTesting({});
  });

  it('creates a PR with default title and body when config has no change_strategy', async () => {
    _setConfigForTesting({});

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })                  // GET repo info
      .mockResolvedValueOnce({ data: { object: { sha: 'head-sha' } } })             // GET ref
      .mockResolvedValueOnce({ data: {} })                                           // POST create ref
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 })) // upsert GET -> 404
      .mockResolvedValueOnce({ data: {} })                                           // upsert PUT
      .mockResolvedValueOnce({ data: { number: 42 } });                              // POST create PR

    const result = await createConfigurationPR(
      octokit, 'owner', 'repo', 'config.yml', 'file content', 'Update config'
    );

    expect(result).toEqual({ number: 42 });

    // Verify PR was created with default title and body
    const prCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/pulls'
    );
    expect(prCall[1]).toMatchObject({
      title: '[Bot] Configuration Update',
      body: 'Automated configuration update',
      maintainer_can_modify: true
    });
  });

  it('uses custom pr_title and pr_body from change_strategy config', async () => {
    _setConfigForTesting({
      change_strategy: {
        pr_title: 'Custom Title',
        pr_body: 'Custom body text'
      }
    });

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'head-sha' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 10 } });

    await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg');

    const prCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/pulls'
    );
    expect(prCall[1]).toMatchObject({
      title: 'Custom Title',
      body: 'Custom body text'
    });
  });

  it('falls back to main when default_branch is not set', async () => {
    _setConfigForTesting({});

    octokit.request
      .mockResolvedValueOnce({ data: {} })                                           // GET repo (no default_branch)
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })                 // GET ref heads/main
      .mockResolvedValueOnce({ data: {} })                                           // POST create ref
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 1 } });

    await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg');

    // Verify the ref GET used 'main' as the branch
    const refCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'GET /repos/{owner}/{repo}/git/ref/heads/{branch}'
    );
    expect(refCall[1].branch).toBe('main');

    // Verify the PR base is 'main'
    const prCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/pulls'
    );
    expect(prCall[1].base).toBe('main');
  });

  it('uses the repo default_branch when available', async () => {
    _setConfigForTesting({});

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'develop' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 5 } });

    await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg');

    const refCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'GET /repos/{owner}/{repo}/git/ref/heads/{branch}'
    );
    expect(refCall[1].branch).toBe('develop');

    const prCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/pulls'
    );
    expect(prCall[1].base).toBe('develop');
  });

  it('adds labels when change_strategy.pr_labels is non-empty', async () => {
    _setConfigForTesting({
      change_strategy: {
        pr_labels: ['bot', 'config']
      }
    });

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 7 } })                               // PR created
      .mockResolvedValueOnce({ data: {} });                                          // POST labels

    await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg');

    const labelsCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels'
    );
    expect(labelsCall).toBeDefined();
    expect(labelsCall[1]).toMatchObject({
      issue_number: 7,
      labels: ['bot', 'config']
    });
  });

  it('skips labels when change_strategy.pr_labels is empty', async () => {
    _setConfigForTesting({
      change_strategy: {
        pr_labels: []
      }
    });

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 8 } });

    await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg');

    const labelsCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels'
    );
    expect(labelsCall).toBeUndefined();
  });

  it('skips labels when change_strategy.pr_labels is not defined', async () => {
    _setConfigForTesting({
      change_strategy: {}
    });

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 9 } });

    await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg');

    const labelsCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels'
    );
    expect(labelsCall).toBeUndefined();
  });

  it('adds reviewers when change_strategy.pr_reviewers is non-empty', async () => {
    _setConfigForTesting({
      change_strategy: {
        pr_reviewers: ['alice', 'bob']
      }
    });

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 11 } })                              // PR created
      .mockResolvedValueOnce({ data: {} });                                          // POST reviewers

    await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg');

    const reviewersCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers'
    );
    expect(reviewersCall).toBeDefined();
    expect(reviewersCall[1]).toMatchObject({
      pull_number: 11,
      reviewers: ['alice', 'bob']
    });
  });

  it('skips reviewers when change_strategy.pr_reviewers is empty', async () => {
    _setConfigForTesting({
      change_strategy: {
        pr_reviewers: []
      }
    });

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 12 } });

    await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg');

    const reviewersCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers'
    );
    expect(reviewersCall).toBeUndefined();
  });

  it('skips reviewers when change_strategy.pr_reviewers is not defined', async () => {
    _setConfigForTesting({
      change_strategy: {}
    });

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 13 } });

    await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg');

    const reviewersCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers'
    );
    expect(reviewersCall).toBeUndefined();
  });

  it('adds both labels and reviewers when both are configured', async () => {
    _setConfigForTesting({
      change_strategy: {
        pr_labels: ['automated'],
        pr_reviewers: ['charlie']
      }
    });

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 20 } })
      .mockResolvedValueOnce({ data: {} })   // labels
      .mockResolvedValueOnce({ data: {} });  // reviewers

    const result = await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg');

    expect(result).toEqual({ number: 20 });

    const labelsCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/issues/{issue_number}/labels'
    );
    expect(labelsCall).toBeDefined();
    expect(labelsCall[1].labels).toEqual(['automated']);

    const reviewersCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers'
    );
    expect(reviewersCall).toBeDefined();
    expect(reviewersCall[1].reviewers).toEqual(['charlie']);
  });

  it('creates the branch from the default branch HEAD sha', async () => {
    _setConfigForTesting({});

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'abc123def' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 3 } });

    await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg');

    const createRefCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/git/refs'
    );
    expect(createRefCall).toBeDefined();
    expect(createRefCall[1].sha).toBe('abc123def');
    expect(createRefCall[1].ref).toMatch(/^refs\/heads\/bot\/config-update-\d+$/);
  });

  it('passes the new branch name to upsertRepoFile and as PR head', async () => {
    _setConfigForTesting({});

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })                                           // POST ref
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 })) // upsert GET
      .mockResolvedValueOnce({ data: {} })                                           // upsert PUT
      .mockResolvedValueOnce({ data: { number: 4 } });

    await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'commit msg');

    // upsertRepoFile's PUT should include the branch
    const putCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'PUT /repos/{owner}/{repo}/contents/{path}'
    );
    expect(putCall[1].branch).toMatch(/^bot\/config-update-\d+$/);

    // PR head should match the branch name
    const prCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'POST /repos/{owner}/{repo}/pulls'
    );
    expect(prCall[1].head).toMatch(/^bot\/config-update-\d+$/);

    // They should be the same branch
    expect(putCall[1].branch).toBe(prCall[1].head);
  });

  it('logs info at the start and end of PR creation', async () => {
    _setConfigForTesting({});

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 99 } });

    await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg');

    expect(getLogger().info).toHaveBeenCalledWith(
      expect.stringContaining('Creating configuration PR for owner/repo')
    );
    expect(getLogger().info).toHaveBeenCalledWith(
      expect.stringContaining('Created configuration PR #99 for owner/repo')
    );
  });

  it('throws and logs error when API call fails', async () => {
    _setConfigForTesting({});

    octokit.request.mockRejectedValueOnce(new Error('API is down'));

    await expect(
      createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg')
    ).rejects.toThrow('API is down');

    expect(getLogger().error).toHaveBeenCalledWith(
      expect.stringContaining('Error creating configuration PR for owner/repo'),
      'API is down'
    );
  });

  it('throws and logs error when branch creation fails', async () => {
    _setConfigForTesting({});

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockRejectedValueOnce(new Error('Reference already exists'));

    await expect(
      createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg')
    ).rejects.toThrow('Reference already exists');

    expect(getLogger().error).toHaveBeenCalledWith(
      expect.stringContaining('Error creating configuration PR'),
      'Reference already exists'
    );
  });

  it('throws and logs error when PR creation fails', async () => {
    _setConfigForTesting({});

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(new Error('Validation failed'));

    await expect(
      createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg')
    ).rejects.toThrow('Validation failed');

    expect(getLogger().error).toHaveBeenCalled();
  });

  it('handles upsertRepoFile updating an existing file on the new branch', async () => {
    _setConfigForTesting({});

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })                                            // POST ref
      .mockResolvedValueOnce({ status: 200, data: { sha: 'existing-file-sha' } })    // upsert GET (file exists)
      .mockResolvedValueOnce({ data: {} })                                            // upsert PUT
      .mockResolvedValueOnce({ data: { number: 50 } });

    const result = await createConfigurationPR(
      octokit, 'owner', 'repo', 'existing.yml', 'new content', 'update existing'
    );

    expect(result).toEqual({ number: 50 });

    // PUT should include the sha from the existing file
    const putCall = octokit.request.mock.calls.find(
      (c) => c[0] === 'PUT /repos/{owner}/{repo}/contents/{path}'
    );
    expect(putCall[1].sha).toBe('existing-file-sha');
  });

  it('uses correct owner and repo in all API calls', async () => {
    _setConfigForTesting({});

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 1 } });

    await createConfigurationPR(octokit, 'my-org', 'my-repo', 'f.yml', 'content', 'msg');

    // Every call should have correct owner/repo
    for (const call of octokit.request.mock.calls) {
      expect(call[1].owner).toBe('my-org');
      expect(call[1].repo).toBe('my-repo');
    }
  });

  it('does not add labels or reviewers when change_strategy is undefined', async () => {
    _setConfigForTesting({});

    octokit.request
      .mockResolvedValueOnce({ data: { default_branch: 'main' } })
      .mockResolvedValueOnce({ data: { object: { sha: 'sha1' } } })
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} })
      .mockResolvedValueOnce({ data: { number: 15 } });

    await createConfigurationPR(octokit, 'owner', 'repo', 'f.yml', 'content', 'msg');

    // Should be exactly 6 calls: GET repo, GET ref, POST ref, GET file (404), PUT file, POST PR
    expect(octokit.request).toHaveBeenCalledTimes(6);
  });
});
