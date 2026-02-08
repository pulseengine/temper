import { normalizeRepoInput, getDefaultBranch, isForkRepo } from '../../src/helpers.js';

describe('helpers', () => {
  describe('normalizeRepoInput', () => {
    it('wraps string owner/repo into object', () => {
      const result = normalizeRepoInput('my-org', 'my-repo');
      expect(result).toEqual({
        name: 'my-repo',
        owner: { login: 'my-org' },
        default_branch: 'main',
        fork: false
      });
    });

    it('passes through a repo object unchanged', () => {
      const repo = { name: 'r', owner: { login: 'o' }, default_branch: 'develop', fork: true };
      expect(normalizeRepoInput(repo)).toBe(repo);
    });
  });

  describe('getDefaultBranch', () => {
    it('returns the default_branch property', () => {
      expect(getDefaultBranch({ default_branch: 'develop' })).toBe('develop');
    });

    it('defaults to main when missing', () => {
      expect(getDefaultBranch({})).toBe('main');
      expect(getDefaultBranch(null)).toBe('main');
      expect(getDefaultBranch(undefined)).toBe('main');
    });
  });

  describe('isForkRepo', () => {
    it('returns true for forks', () => {
      expect(isForkRepo({ fork: true })).toBe(true);
    });

    it('returns false for non-forks', () => {
      expect(isForkRepo({ fork: false })).toBe(false);
      expect(isForkRepo({})).toBe(false);
      expect(isForkRepo(null)).toBe(false);
    });
  });
});
