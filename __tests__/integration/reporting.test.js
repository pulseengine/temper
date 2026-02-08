import { generateConfigurationReport, verifyCIAttestation } from '../../src/reporting.js';
import { _setConfigForTesting } from '../../src/config.js';

function createMockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ status: 200, data: {} }),
    paginate: jest.fn().mockResolvedValue([])
  };
}

describe('generateConfigurationReport', () => {
  let octokit;

  beforeEach(() => {
    octokit = createMockOctokit();
    _setConfigForTesting({});
  });

  afterEach(() => {
    _setConfigForTesting({});
  });

  it('returns a report string with expected sections', async () => {
    octokit.request
      .mockResolvedValueOnce({
        data: {
          default_branch: 'main',
          allow_merge_commit: false,
          allow_squash_merge: true,
          allow_rebase_merge: true,
          delete_branch_on_merge: true
        }
      }) // GET /repos/{owner}/{repo}
      .mockResolvedValueOnce({
        data: {
          required_status_checks: { contexts: ['ci/build'] },
          enforce_admins: { enabled: true },
          required_pull_request_reviews: {
            required_approving_review_count: 2,
            dismiss_stale_reviews: true,
            require_code_owner_reviews: true
          }
        }
      }) // GET branch protection
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from('version: 2').toString('base64')
        }
      }); // GET dependabot.yml

    octokit.paginate.mockResolvedValue([
      { name: 'bug', color: 'ff0000', description: 'Bug reports' },
      { name: 'enhancement', color: '00ff00', description: 'New features' }
    ]);

    const report = await generateConfigurationReport(octokit, 'owner', 'repo');

    expect(typeof report).toBe('string');
    expect(report).toContain('## Configuration Report for owner/repo');
    expect(report).toContain('### Repository Settings');
    expect(report).toContain('Merge Commit: false');
    expect(report).toContain('Squash Merge: true');
    expect(report).toContain('Rebase Merge: true');
    expect(report).toContain('Delete Branch on Merge: true');
    expect(report).toContain('### Branch Protection');
    expect(report).toContain('ci/build');
    expect(report).toContain('Enforce Admins: true');
    expect(report).toContain('Required Reviews: 2');
    expect(report).toContain('Dismiss Stale Reviews: true');
    expect(report).toContain('Require Code Owner Reviews: true');
    expect(report).toContain('### Issue Labels (2)');
    expect(report).toContain('bug');
    expect(report).toContain('enhancement');
    expect(report).toContain('### Dependabot Configuration');
    expect(report).toContain('version: 2');
  });

  it('handles missing branch protection (404)', async () => {
    octokit.request
      .mockResolvedValueOnce({
        data: {
          default_branch: 'main',
          allow_merge_commit: true,
          allow_squash_merge: true,
          allow_rebase_merge: false,
          delete_branch_on_merge: false
        }
      })
      .mockRejectedValueOnce({ status: 404, message: 'Not Found' }) // branch protection 404
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from('version: 2').toString('base64')
        }
      });

    octokit.paginate.mockResolvedValue([]);

    const report = await generateConfigurationReport(octokit, 'owner', 'repo');

    expect(report).toContain('No branch protection configured');
    expect(report).toContain('### Issue Labels (0)');
  });

  it('handles missing dependabot config', async () => {
    octokit.request
      .mockResolvedValueOnce({
        data: {
          default_branch: 'main',
          allow_merge_commit: true,
          allow_squash_merge: true,
          allow_rebase_merge: true,
          delete_branch_on_merge: true
        }
      })
      .mockRejectedValueOnce({ status: 404, message: 'Not Found' }) // branch protection 404
      .mockRejectedValueOnce({ status: 404, message: 'Not Found' }); // dependabot 404

    octokit.paginate.mockResolvedValue([]);

    const report = await generateConfigurationReport(octokit, 'owner', 'repo');

    expect(report).toContain('No Dependabot configuration found');
  });

  it('returns error message on non-404 API failure', async () => {
    octokit.request.mockRejectedValue(new Error('Server error'));

    const report = await generateConfigurationReport(octokit, 'owner', 'repo');

    expect(report).toContain('Error generating configuration report');
    expect(report).toContain('Server error');
  });

  it('rethrows non-404 branch protection errors', async () => {
    octokit.request
      .mockResolvedValueOnce({
        data: {
          default_branch: 'main',
          allow_merge_commit: true,
          allow_squash_merge: true,
          allow_rebase_merge: true,
          delete_branch_on_merge: true
        }
      })
      .mockRejectedValueOnce({ status: 500, message: 'Internal error' }); // non-404 error

    const report = await generateConfigurationReport(octokit, 'owner', 'repo');

    // The outer catch block catches the rethrown error and returns error string
    expect(report).toContain('Error generating configuration report');
  });

  it('uses default_branch from repo settings', async () => {
    octokit.request
      .mockResolvedValueOnce({
        data: {
          default_branch: 'develop',
          allow_merge_commit: true,
          allow_squash_merge: true,
          allow_rebase_merge: true,
          delete_branch_on_merge: true
        }
      })
      .mockResolvedValueOnce({
        data: {
          required_status_checks: { contexts: [] },
          enforce_admins: { enabled: false },
          required_pull_request_reviews: {
            required_approving_review_count: 1,
            dismiss_stale_reviews: false,
            require_code_owner_reviews: false
          }
        }
      })
      .mockResolvedValueOnce({
        data: {
          content: Buffer.from('version: 2').toString('base64')
        }
      });

    octokit.paginate.mockResolvedValue([]);

    await generateConfigurationReport(octokit, 'owner', 'repo');

    // Verify that branch protection was requested for 'develop' branch
    expect(octokit.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/branches/{branch}/protection',
      expect.objectContaining({ branch: 'develop' })
    );
  });
});

describe('verifyCIAttestation', () => {
  let octokit;

  beforeEach(() => {
    octokit = createMockOctokit();
    _setConfigForTesting({});
  });

  afterEach(() => {
    _setConfigForTesting({});
  });

  it('returns compliant:true when all required checks are present', async () => {
    octokit.request.mockResolvedValue({
      data: {
        required_status_checks: {
          contexts: ['ci/build', 'ci/test', 'ci/lint']
        }
      }
    });

    const ciConfig = {
      required_checks: ['ci/build', 'ci/test']
    };

    const result = await verifyCIAttestation(octokit, 'owner', 'repo', 'main', ciConfig);

    expect(result.compliant).toBe(true);
    expect(result.missingChecks).toBeUndefined();
  });

  it('returns compliant:false with missingChecks when checks are missing', async () => {
    octokit.request.mockResolvedValue({
      data: {
        required_status_checks: {
          contexts: ['ci/build']
        }
      }
    });

    const ciConfig = {
      required_checks: ['ci/build', 'ci/test', 'ci/lint']
    };

    const result = await verifyCIAttestation(octokit, 'owner', 'repo', 'main', ciConfig);

    expect(result.compliant).toBe(false);
    expect(result.missingChecks).toEqual(['ci/test', 'ci/lint']);
  });

  it('returns compliant:false when no required checks match', async () => {
    octokit.request.mockResolvedValue({
      data: {
        required_status_checks: {
          contexts: []
        }
      }
    });

    const ciConfig = {
      required_checks: ['ci/build', 'ci/test']
    };

    const result = await verifyCIAttestation(octokit, 'owner', 'repo', 'main', ciConfig);

    expect(result.compliant).toBe(false);
    expect(result.missingChecks).toEqual(['ci/build', 'ci/test']);
  });

  it('returns compliant:true when required_checks is empty', async () => {
    octokit.request.mockResolvedValue({
      data: {
        required_status_checks: {
          contexts: ['ci/build']
        }
      }
    });

    const ciConfig = { required_checks: [] };

    const result = await verifyCIAttestation(octokit, 'owner', 'repo', 'main', ciConfig);

    expect(result.compliant).toBe(true);
  });

  it('returns compliant:false with error message on API failure', async () => {
    octokit.request.mockRejectedValue(new Error('Branch not found'));

    const ciConfig = { required_checks: ['ci/build'] };

    const result = await verifyCIAttestation(octokit, 'owner', 'repo', 'main', ciConfig);

    expect(result.compliant).toBe(false);
    expect(result.error).toBe('Branch not found');
    expect(result.missingChecks).toBeUndefined();
  });

  it('passes branch parameter to the API call', async () => {
    octokit.request.mockResolvedValue({
      data: {
        required_status_checks: {
          contexts: ['ci/build']
        }
      }
    });

    const ciConfig = { required_checks: ['ci/build'] };

    await verifyCIAttestation(octokit, 'owner', 'repo', 'develop', ciConfig);

    expect(octokit.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/branches/{branch}/protection',
      expect.objectContaining({ owner: 'owner', repo: 'repo', branch: 'develop' })
    );
  });

  it('handles missing contexts array gracefully as error', async () => {
    octokit.request.mockResolvedValue({
      data: {
        required_status_checks: {}
      }
    });

    const ciConfig = { required_checks: ['ci/build'] };

    const result = await verifyCIAttestation(octokit, 'owner', 'repo', 'main', ciConfig);

    // When contexts is undefined, the filter operates on undefined which throws,
    // caught by the error handler
    expect(result.compliant).toBe(false);
  });
});
