import { applyBranchProtection, setRequiredSignatures } from '../../src/branch-protection.js';

function createMockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ status: 200, data: {} }),
    paginate: jest.fn().mockResolvedValue([]),
    issues: {
      create: jest.fn().mockResolvedValue({ data: { number: 1 } }),
      createComment: jest.fn().mockResolvedValue({ data: {} })
    }
  };
}

describe('branch-protection', () => {
  let octokit;
  beforeEach(() => { octokit = createMockOctokit(); });

  describe('applyBranchProtection', () => {
    it('calls PUT branch protection with correct params', async () => {
      await applyBranchProtection(octokit, 'owner', 'repo', 'main', {
        enforce_admins: true,
        required_status_checks: { strict: true, contexts: ['ci'] }
      });

      expect(octokit.request).toHaveBeenCalledWith(
        'PUT /repos/{owner}/{repo}/branches/{branch}/protection',
        expect.objectContaining({
          owner: 'owner',
          repo: 'repo',
          branch: 'main',
          enforce_admins: true
        })
      );
    });

    it('calls setRequiredSignatures when configured', async () => {
      await applyBranchProtection(octokit, 'owner', 'repo', 'main', {
        require_signed_commits: true
      });

      expect(octokit.request).toHaveBeenCalledWith(
        'POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures',
        expect.objectContaining({ owner: 'owner', repo: 'repo', branch: 'main' })
      );
    });

    it('does not call setRequiredSignatures when not configured', async () => {
      await applyBranchProtection(octokit, 'owner', 'repo', 'main', {
        enforce_admins: true
      });

      // A GET of the existing protection (to keep its contexts) and the PUT;
      // no POST/DELETE for signatures.
      const routes = octokit.request.mock.calls.map((c) => c[0]);
      expect(routes).toEqual([
        'GET /repos/{owner}/{repo}/branches/{branch}/protection',
        'PUT /repos/{owner}/{repo}/branches/{branch}/protection'
      ]);
      expect(octokit.request).toHaveBeenCalledWith(
        'PUT /repos/{owner}/{repo}/branches/{branch}/protection',
        expect.anything()
      );
    });

    it('propagates errors from the API', async () => {
      octokit.request.mockRejectedValue(new Error('Forbidden'));
      await expect(
        applyBranchProtection(octokit, 'owner', 'repo', 'main', { enforce_admins: true })
      ).rejects.toThrow('Forbidden');
    });
  });

  describe('setRequiredSignatures', () => {
    it('POSTs when enabled', async () => {
      await setRequiredSignatures(octokit, 'o', 'r', 'main', true);
      expect(octokit.request).toHaveBeenCalledWith(
        'POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures',
        { owner: 'o', repo: 'r', branch: 'main' }
      );
    });

    it('DELETEs when disabled', async () => {
      await setRequiredSignatures(octokit, 'o', 'r', 'main', false);
      expect(octokit.request).toHaveBeenCalledWith(
        'DELETE /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures',
        { owner: 'o', repo: 'r', branch: 'main' }
      );
    });

    it('swallows 404 errors gracefully', async () => {
      octokit.request.mockRejectedValue({ status: 404, message: 'Not found' });
      await expect(setRequiredSignatures(octokit, 'o', 'r', 'main', true)).resolves.toBeUndefined();
    });

    it('swallows 422 errors gracefully', async () => {
      octokit.request.mockRejectedValue({ status: 422, message: 'Unprocessable' });
      await expect(setRequiredSignatures(octokit, 'o', 'r', 'main', true)).resolves.toBeUndefined();
    });

    it('rethrows non-404/422 errors', async () => {
      const error = new Error('Server error');
      error.status = 500;
      octokit.request.mockRejectedValue(error);
      await expect(setRequiredSignatures(octokit, 'o', 'r', 'main', true)).rejects.toThrow('Server error');
    });
  });
});

describe('applyBranchProtection keeps per-repo contexts', () => {
  it('unions the contexts the branch already requires into the PUT (never wipes them)', async () => {
    const octokit = {
      request: jest.fn().mockImplementation((route) => {
        if (route.startsWith('GET ')) {
          return Promise.resolve({
            data: { required_status_checks: { contexts: ['Format', 'Test'], checks: [{ context: 'Miri' }] } }
          });
        }
        return Promise.resolve({ status: 200, data: {} });
      })
    };
    await applyBranchProtection(octokit, 'o', 'r', 'main', {
      required_status_checks: { strict: true, contexts: [] }
    });
    const put = octokit.request.mock.calls.find((c) => c[0].startsWith('PUT '));
    expect(put[1].required_status_checks.contexts.sort()).toEqual(['Format', 'Miri', 'Test']);
  });

  it('treats an unprotected branch (404) as no existing contexts', async () => {
    const octokit = {
      request: jest.fn().mockImplementation((route) => {
        if (route.startsWith('GET ')) return Promise.reject(Object.assign(new Error('nf'), { status: 404 }));
        return Promise.resolve({ status: 200, data: {} });
      })
    };
    await applyBranchProtection(octokit, 'o', 'r', 'main', { required_status_checks: { contexts: ['ci'] } });
    const put = octokit.request.mock.calls.find((c) => c[0].startsWith('PUT '));
    expect(put[1].required_status_checks.contexts).toEqual(['ci']);
  });
});
