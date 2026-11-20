// /health's version on a release dir (no .git): smithy's systemd unit sets
// TEMPER_COMMIT to the deployed sha; a checkout falls back to git.

jest.mock('../../src/organization.js', () => ({
  analyzeOrganizationRepositories: jest.fn(),
  synchronizeAllRepositories: jest.fn(),
  generateOrganizationAnalysisReport: jest.fn()
}));
jest.mock('../../src/dependabot.js', () => ({
  checkDependabotConfiguration: jest.fn(),
  checkExistingDependabotConfig: jest.fn(),
  fixDependabotPRLabels: jest.fn()
}));
jest.mock('../../src/reporting.js', () => ({
  generateConfigurationReport: jest.fn()
}));
jest.mock('../../src/ai-review.js', () => ({
  getReviews: jest.fn(),
  getReviewStats: jest.fn(),
  reviewPullRequest: jest.fn()
}));
jest.mock('../../src/config.js', () => ({
  getConfig: jest.fn(() => ({}))
}));
jest.mock('../../src/logger.js', () => ({
  getLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }))
}));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));

import { resolveDeployCommit } from '../../src/dashboard.js';

const SHA = 'b151f24c0ffee0123456789abcdef0123456789a';
const OTHER = '0996f50dd1b3a133081056e38f91a89126bdbfe2';
const noGit = () => { throw new Error('not a git repository'); };

describe('resolveDeployCommit', () => {
  it('reads TEMPER_COMMIT when the release dir has no .git', () => {
    expect(resolveDeployCommit({ TEMPER_COMMIT: SHA }, noGit)).toBe(SHA);
  });
  it('prefers TEMPER_COMMIT over git, normalising case and whitespace', () => {
    expect(resolveDeployCommit({ TEMPER_COMMIT: ` ${SHA.toUpperCase()}\n` }, () => OTHER)).toBe(SHA);
  });
  it('falls back to git rev-parse in a checkout', () => {
    expect(resolveDeployCommit({}, () => `${OTHER}\n`)).toBe(OTHER);
  });
  it.each([['a short sha', 'b151f24'], ['not hex', 'z'.repeat(40)], ['a ref name', 'main']])(
    'ignores a TEMPER_COMMIT that is %s', (_, v) => {
      expect(resolveDeployCommit({ TEMPER_COMMIT: v }, noGit)).toBe('unknown');
      expect(resolveDeployCommit({ TEMPER_COMMIT: v }, () => OTHER)).toBe(OTHER);
    });
  it('is unknown with neither', () => {
    expect(resolveDeployCommit({}, noGit)).toBe('unknown');
  });
});
