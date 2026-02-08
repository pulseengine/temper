import { checkExistingDependabotConfig, fixDependabotPRLabels } from '../../src/dependabot.js';
import { _setConfigForTesting } from '../../src/config.js';
import yaml from 'js-yaml';

function createMockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ status: 200, data: {} }),
    paginate: jest.fn().mockResolvedValue([])
  };
}

describe('dependabot', () => {
  let octokit;
  beforeEach(() => {
    octokit = createMockOctokit();
    _setConfigForTesting({
      dependabot: { version: 2, updates: [{ labels: ['dependencies'] }] }
    });
  });
  afterEach(() => { _setConfigForTesting({}); });

  describe('checkExistingDependabotConfig', () => {
    it('returns exists:false when 404', async () => {
      octokit.request.mockRejectedValue({ status: 404 });
      const result = await checkExistingDependabotConfig(octokit, 'o', 'r');
      expect(result.exists).toBe(false);
      expect(result.labelIssues).toEqual([]);
    });

    it('detects matching config', async () => {
      const targetYaml = yaml.dump({ version: 2, updates: [{ labels: ['dependencies'] }] });
      const b64 = Buffer.from(targetYaml).toString('base64');

      octokit.request.mockResolvedValue({ data: { content: b64 } });
      octokit.paginate.mockResolvedValue([]);

      const result = await checkExistingDependabotConfig(octokit, 'o', 'r');
      expect(result.exists).toBe(true);
    });

    it('detects mismatching config', async () => {
      const differentConfig = yaml.dump({ version: 2, updates: [{ labels: ['other'] }] });
      const b64 = Buffer.from(differentConfig).toString('base64');

      octokit.request.mockResolvedValue({ data: { content: b64 } });
      octokit.paginate.mockResolvedValue([]);

      const result = await checkExistingDependabotConfig(octokit, 'o', 'r');
      expect(result.exists).toBe(true);
      expect(result.matchesTarget).toBe(false);
    });

    it('detects PRs with missing labels', async () => {
      const configYaml = yaml.dump({ version: 2, updates: [{ labels: ['dependencies'] }] });
      const b64 = Buffer.from(configYaml).toString('base64');

      octokit.request.mockResolvedValue({ data: { content: b64 } });
      octokit.paginate.mockResolvedValue([
        { number: 10, pull_request: {}, labels: [] },
        { number: 11, pull_request: {}, labels: [{ name: 'dependencies' }] },
        { number: 12, labels: [] } // Not a PR (no pull_request field)
      ]);

      const result = await checkExistingDependabotConfig(octokit, 'o', 'r');
      expect(result.labelIssues).toHaveLength(1);
      expect(result.labelIssues[0].number).toBe(10);
      expect(result.labelIssues[0].missingLabels).toEqual(['dependencies']);
      expect(result.dependabotPRCount).toBe(2);
    });
  });

  describe('fixDependabotPRLabels', () => {
    it('adds missing labels to PRs', async () => {
      const issues = [
        { number: 1, missingLabels: ['dependencies'] },
        { number: 2, missingLabels: ['automation'] }
      ];

      const result = await fixDependabotPRLabels(octokit, 'o', 'r', issues);

      expect(result.success).toBe(true);
      expect(result.fixedIssues).toBe(2);
      expect(octokit.request).toHaveBeenCalledTimes(2);
    });

    it('calls the correct API endpoint for each issue', async () => {
      const issues = [
        { number: 5, missingLabels: ['dependencies', 'automation'] }
      ];

      await fixDependabotPRLabels(octokit, 'o', 'r', issues);

      expect(octokit.request).toHaveBeenCalledWith(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/labels',
        expect.objectContaining({
          owner: 'o',
          repo: 'r',
          issue_number: 5,
          labels: ['dependencies', 'automation']
        })
      );
    });

    it('handles empty issues list', async () => {
      const result = await fixDependabotPRLabels(octokit, 'o', 'r', []);
      expect(result.success).toBe(true);
      expect(result.fixedIssues).toBe(0);
      expect(octokit.request).not.toHaveBeenCalled();
    });
  });
});
