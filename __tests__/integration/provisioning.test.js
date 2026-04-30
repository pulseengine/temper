jest.mock('../../src/repository.js', () => ({
  configureRepository: jest.fn().mockResolvedValue({ success: true })
}));

jest.mock('../../src/logger.js', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { getLogger: jest.fn(() => log) };
});

import {
  parseIssueFormBody,
  validateProvisionRequest,
  provisionRepo
} from '../../src/provisioning.js';
import { configureRepository } from '../../src/repository.js';
import { _setConfigForTesting } from '../../src/config.js';

describe('parseIssueFormBody', () => {
  it('extracts headings and content', () => {
    const body = `### Repository name\n\nmy-new-repo\n\n### Visibility\n\nprivate\n`;
    expect(parseIssueFormBody(body)).toEqual({
      'repository name': 'my-new-repo',
      visibility: 'private'
    });
  });

  it('drops _No response_ entries', () => {
    const body = `### Description\n\n_No response_\n\n### Topics\n\nweb, async`;
    const parsed = parseIssueFormBody(body);
    expect(parsed.description).toBeUndefined();
    expect(parsed.topics).toBe('web, async');
  });

  it('preserves multi-line content', () => {
    const body = `### Description\n\nLine one\nLine two\n\n### Visibility\n\nprivate`;
    const parsed = parseIssueFormBody(body);
    expect(parsed.description).toBe('Line one\nLine two');
  });

  it('returns empty object for non-string input', () => {
    expect(parseIssueFormBody(undefined)).toEqual({});
    expect(parseIssueFormBody(null)).toEqual({});
  });

  it('lowercases keys for case-insensitive lookup', () => {
    const body = `### Repository Name\n\nfoo`;
    expect(parseIssueFormBody(body)['repository name']).toBe('foo');
  });
});

describe('validateProvisionRequest', () => {
  it('rejects when name missing', () => {
    expect(validateProvisionRequest({}).valid).toBe(false);
  });

  it('rejects names with disallowed characters', () => {
    expect(validateProvisionRequest({ 'repository name': 'has space' }).valid).toBe(false);
    expect(validateProvisionRequest({ 'repository name': 'no/slash' }).valid).toBe(false);
  });

  it('rejects unknown visibility', () => {
    const r = validateProvisionRequest({
      'repository name': 'ok',
      visibility: 'top-secret'
    });
    expect(r.valid).toBe(false);
  });

  it('defaults visibility to private', () => {
    const r = validateProvisionRequest({ 'repository name': 'ok' });
    expect(r.valid).toBe(true);
    expect(r.params.visibility).toBe('private');
  });

  it('parses topics CSV', () => {
    const r = validateProvisionRequest({
      'repository name': 'ok',
      topics: ' webassembly, safety-critical , Formal'
    });
    expect(r.params.topics).toEqual(['webassembly', 'safety-critical', 'formal']);
  });

  it('accepts internal visibility', () => {
    const r = validateProvisionRequest({
      'repository name': 'ok',
      visibility: 'internal'
    });
    expect(r.valid).toBe(true);
    expect(r.params.visibility).toBe('internal');
  });

  describe('repository name rules (GitHub parity)', () => {
    it('rejects names starting with a dot', () => {
      const r = validateProvisionRequest({ 'repository name': '.foo' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/cannot start with '\.' or '-'/);
    });

    it('rejects names starting with a dash', () => {
      const r = validateProvisionRequest({ 'repository name': '-foo' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/cannot start with '\.' or '-'/);
    });

    it('rejects names ending in .git', () => {
      const r = validateProvisionRequest({ 'repository name': 'foo.git' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/cannot end with '\.git'/);
    });

    it('rejects the reserved bare name "."', () => {
      const r = validateProvisionRequest({ 'repository name': '.' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/reserved|cannot start/);
    });

    it('rejects the reserved bare name ".."', () => {
      const r = validateProvisionRequest({ 'repository name': '..' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/reserved|cannot start/);
    });

    it('rejects empty / whitespace-only names', () => {
      expect(validateProvisionRequest({ 'repository name': '' }).valid).toBe(false);
      const r = validateProvisionRequest({ 'repository name': '   ' });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/cannot be empty|Missing field/);
    });

    it('rejects names longer than 100 characters', () => {
      const longName = 'a'.repeat(101);
      const r = validateProvisionRequest({ 'repository name': longName });
      expect(r.valid).toBe(false);
      expect(r.error).toMatch(/too long/);
    });

    it('accepts a well-formed name with allowed punctuation', () => {
      const r = validateProvisionRequest({ 'repository name': 'valid-name_1.0' });
      expect(r.valid).toBe(true);
      expect(r.params.name).toBe('valid-name_1.0');
    });
  });
});

describe('provisionRepo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _setConfigForTesting({ organization: 'pulseengine' });
  });

  afterEach(() => {
    _setConfigForTesting({});
  });

  function makeOctokit(createdRepo) {
    return {
      request: jest.fn().mockImplementation((route) => {
        if (route === 'POST /orgs/{org}/repos') {
          return Promise.resolve({ data: createdRepo });
        }
        if (route === 'POST /repos/{template_owner}/{template_repo}/generate') {
          return Promise.resolve({ data: createdRepo });
        }
        return Promise.resolve({ data: {} });
      })
    };
  }

  it('creates a plain repo when no template provided, applies config, comments, closes issue', async () => {
    const created = {
      name: 'new-svc',
      html_url: 'https://github.com/pulseengine/new-svc',
      default_branch: 'main'
    };
    const octokit = makeOctokit(created);

    await provisionRepo(
      {
        sourceOwner: 'pulseengine',
        sourceRepo: 'repo-requests',
        sourceIssue: 42,
        params: { name: 'new-svc', visibility: 'private', description: 'svc', topics: [] }
      },
      { octokit }
    );

    expect(octokit.request).toHaveBeenCalledWith(
      'POST /orgs/{org}/repos',
      expect.objectContaining({ org: 'pulseengine', name: 'new-svc' })
    );
    expect(configureRepository).toHaveBeenCalledWith(
      octokit,
      created,
      undefined,
      { skipBranchScopedWork: false }
    );
    // Confirmation comment + close issue
    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      expect.objectContaining({ issue_number: 42 })
    );
    expect(octokit.request).toHaveBeenCalledWith(
      'PATCH /repos/{owner}/{repo}/issues/{issue_number}',
      expect.objectContaining({ state: 'closed', state_reason: 'completed' })
    );
  });

  it('uses template generation when templateRepo is set', async () => {
    const created = {
      name: 'from-tpl',
      html_url: 'x',
      default_branch: 'main'
    };
    const octokit = makeOctokit(created);
    await provisionRepo(
      {
        sourceOwner: 'pulseengine',
        sourceRepo: 'repo-requests',
        sourceIssue: 1,
        params: {
          name: 'from-tpl',
          visibility: 'private',
          description: 'd',
          templateRepo: 'pulseengine/template-rust',
          topics: ['rust']
        }
      },
      { octokit }
    );
    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{template_owner}/{template_repo}/generate',
      expect.objectContaining({
        template_owner: 'pulseengine',
        template_repo: 'template-rust',
        owner: 'pulseengine',
        name: 'from-tpl'
      })
    );
    // Topics applied
    expect(octokit.request).toHaveBeenCalledWith(
      'PUT /repos/{owner}/{repo}/topics',
      expect.objectContaining({ names: ['rust'] })
    );
  });

  it('comments and rethrows when repo creation fails', async () => {
    const octokit = {
      request: jest.fn().mockImplementation((route) => {
        if (route === 'POST /orgs/{org}/repos') {
          const err = new Error('name already exists');
          err.status = 422;
          return Promise.reject(err);
        }
        return Promise.resolve({ data: {} });
      })
    };

    await expect(
      provisionRepo(
        {
          sourceOwner: 'pulseengine',
          sourceRepo: 'repo-requests',
          sourceIssue: 99,
          params: { name: 'taken', visibility: 'private', description: 'd', topics: [] }
        },
        { octokit }
      )
    ).rejects.toThrow(/name already exists/);

    // Failure comment posted before rethrow
    expect(octokit.request).toHaveBeenCalledWith(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      expect.objectContaining({ issue_number: 99 })
    );
  });
});
