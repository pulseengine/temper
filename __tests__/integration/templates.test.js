// jest.mock() calls are hoisted by babel above all other code, so factories
// must be self-contained. We import the mocked modules after the mock
// declarations and reference the mock functions through those imports.

jest.mock('fs', () => ({
  __esModule: true,
  default: {
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    readdirSync: jest.fn(),
    statSync: jest.fn()
  }
}));

jest.mock('../../src/github-api.js', () => ({
  upsertRepoFile: jest.fn().mockResolvedValue({})
}));

jest.mock('../../src/logger.js', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { getLogger: () => logger };
});

import fs from 'fs';
import { applyTemplates, applyCodeowners } from '../../src/templates.js';
import { upsertRepoFile } from '../../src/github-api.js';
import { getLogger } from '../../src/logger.js';

function createMockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ status: 200, data: {} })
  };
}

describe('applyTemplates', () => {
  let octokit;

  beforeEach(() => {
    octokit = createMockOctokit();
    jest.clearAllMocks();
    upsertRepoFile.mockResolvedValue({});
  });

  it('upserts pull request template when file exists', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('PR template content');

    const templatesConfig = { pull_request: 'templates/pull_request.md' };
    await applyTemplates(octokit, 'owner', 'repo', templatesConfig);

    expect(upsertRepoFile).toHaveBeenCalledWith(
      octokit,
      'owner',
      'repo',
      '.github/PULL_REQUEST_TEMPLATE.md',
      'PR template content',
      'Add/Update pull request template'
    );
  });

  it('skips pull request template when file does not exist', async () => {
    fs.existsSync.mockReturnValue(false);

    const templatesConfig = { pull_request: 'templates/nonexistent.md' };
    await applyTemplates(octokit, 'owner', 'repo', templatesConfig);

    expect(getLogger().warn).toHaveBeenCalledWith(
      expect.stringContaining('Pull request template not found')
    );
    expect(upsertRepoFile).not.toHaveBeenCalled();
  });

  it('upserts each .md, .yml, and .yaml issue template from directory', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ isDirectory: () => true });
    fs.readdirSync.mockReturnValue(['bug.md', 'feature.yml', 'config.yaml', 'README.txt']);
    fs.readFileSync.mockImplementation((filePath) => {
      if (filePath.includes('bug.md')) return 'Bug template';
      if (filePath.includes('feature.yml')) return 'Feature template';
      if (filePath.includes('config.yaml')) return 'Config template';
      return '';
    });

    const templatesConfig = { issue: 'templates/issues' };
    await applyTemplates(octokit, 'owner', 'repo', templatesConfig);

    expect(upsertRepoFile).toHaveBeenCalledWith(
      octokit, 'owner', 'repo',
      '.github/ISSUE_TEMPLATE/bug.md', 'Bug template', 'Add/Update issue template: bug.md'
    );
    expect(upsertRepoFile).toHaveBeenCalledWith(
      octokit, 'owner', 'repo',
      '.github/ISSUE_TEMPLATE/feature.yml', 'Feature template', 'Add/Update issue template: feature.yml'
    );
    expect(upsertRepoFile).toHaveBeenCalledWith(
      octokit, 'owner', 'repo',
      '.github/ISSUE_TEMPLATE/config.yaml', 'Config template', 'Add/Update issue template: config.yaml'
    );
    // README.txt should be skipped
    expect(upsertRepoFile).toHaveBeenCalledTimes(3);
  });

  it('skips issue templates when directory does not exist', async () => {
    fs.existsSync.mockReturnValue(false);

    const templatesConfig = { issue: 'templates/issues' };
    await applyTemplates(octokit, 'owner', 'repo', templatesConfig);

    expect(getLogger().warn).toHaveBeenCalledWith(
      expect.stringContaining('Issue template directory not found')
    );
    expect(upsertRepoFile).not.toHaveBeenCalled();
  });

  it('skips issue templates when path is not a directory', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ isDirectory: () => false });

    const templatesConfig = { issue: 'templates/issues' };
    await applyTemplates(octokit, 'owner', 'repo', templatesConfig);

    expect(getLogger().warn).toHaveBeenCalledWith(
      expect.stringContaining('Issue template directory not found')
    );
    expect(upsertRepoFile).not.toHaveBeenCalled();
  });

  it('handles both pull_request and issue templates together', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.statSync.mockReturnValue({ isDirectory: () => true });
    fs.readFileSync.mockReturnValue('template content');
    fs.readdirSync.mockReturnValue(['bug.md']);

    const templatesConfig = {
      pull_request: 'templates/pr.md',
      issue: 'templates/issues'
    };
    await applyTemplates(octokit, 'owner', 'repo', templatesConfig);

    expect(upsertRepoFile).toHaveBeenCalledWith(
      octokit, 'owner', 'repo',
      '.github/PULL_REQUEST_TEMPLATE.md', 'template content', 'Add/Update pull request template'
    );
    expect(upsertRepoFile).toHaveBeenCalledWith(
      octokit, 'owner', 'repo',
      '.github/ISSUE_TEMPLATE/bug.md', 'template content', 'Add/Update issue template: bug.md'
    );
  });

  it('does nothing when config has no template keys', async () => {
    await applyTemplates(octokit, 'owner', 'repo', {});
    expect(upsertRepoFile).not.toHaveBeenCalled();
  });

  it('propagates errors from upsertRepoFile', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('content');
    upsertRepoFile.mockRejectedValue(new Error('GitHub API error'));

    const templatesConfig = { pull_request: 'templates/pr.md' };

    await expect(
      applyTemplates(octokit, 'owner', 'repo', templatesConfig)
    ).rejects.toThrow('GitHub API error');

    expect(getLogger().error).toHaveBeenCalledWith(
      expect.stringContaining('Error applying templates')
    );
  });
});

describe('applyCodeowners', () => {
  let octokit;

  beforeEach(() => {
    octokit = createMockOctokit();
    jest.clearAllMocks();
    upsertRepoFile.mockResolvedValue({});
  });

  it('upserts CODEOWNERS when file exists', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('* @org/team');

    await applyCodeowners(octokit, 'owner', 'repo', 'CODEOWNERS');

    expect(upsertRepoFile).toHaveBeenCalledWith(
      octokit, 'owner', 'repo',
      '.github/CODEOWNERS', '* @org/team', 'Add/Update CODEOWNERS'
    );
    expect(getLogger().info).toHaveBeenCalledWith(
      expect.stringContaining('CODEOWNERS applied')
    );
  });

  it('returns without error when CODEOWNERS file does not exist', async () => {
    fs.existsSync.mockReturnValue(false);

    await applyCodeowners(octokit, 'owner', 'repo', 'CODEOWNERS');

    expect(getLogger().warn).toHaveBeenCalledWith(
      expect.stringContaining('CODEOWNERS not found')
    );
    expect(upsertRepoFile).not.toHaveBeenCalled();
  });

  it('propagates errors from upsertRepoFile', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockReturnValue('* @org/team');
    upsertRepoFile.mockRejectedValue(new Error('Permission denied'));

    await expect(
      applyCodeowners(octokit, 'owner', 'repo', 'CODEOWNERS')
    ).rejects.toThrow('Permission denied');

    expect(getLogger().error).toHaveBeenCalledWith(
      expect.stringContaining('Error applying CODEOWNERS')
    );
  });

  it('propagates errors from fs.readFileSync', async () => {
    fs.existsSync.mockReturnValue(true);
    fs.readFileSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    await expect(
      applyCodeowners(octokit, 'owner', 'repo', 'CODEOWNERS')
    ).rejects.toThrow('EACCES: permission denied');
  });
});
