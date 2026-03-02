// jest.mock() calls are hoisted by babel above all other code, so factories
// must be self-contained. We import the mocked modules after the mock
// declarations and reference the mock functions through those imports.

jest.mock('../../src/github-api.js', () => ({
  upsertRepoFile: jest.fn().mockResolvedValue({}),
  createConfigurationPR: jest.fn().mockResolvedValue({})
}));

jest.mock('../../src/ai-review.js', () => ({
  callLocalAI: jest.fn()
}));

jest.mock('../../src/logger.js', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { getLogger: () => mockLogger };
});

import {
  applyDependabotConfig,
  checkExistingDependabotConfig,
  extractLabelsFromConfig,
  fixDependabotPRLabels,
  checkDependabotConfiguration,
  generateDependabotConfig,
  buildDependabotYaml,
  enhanceDependabotWithAI
} from '../../src/dependabot.js';
import { _setConfigForTesting } from '../../src/config.js';
import { upsertRepoFile, createConfigurationPR } from '../../src/github-api.js';
import { callLocalAI } from '../../src/ai-review.js';
import { getLogger } from '../../src/logger.js';
import yaml from 'js-yaml';

function createMockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ status: 200, data: {} }),
    paginate: jest.fn().mockResolvedValue([])
  };
}

/** Encode a JS object as base64 YAML, matching how GitHub returns file content. */
function encodeConfig(obj) {
  return Buffer.from(yaml.dump(obj)).toString('base64');
}

describe('dependabot', () => {
  let octokit;

  beforeEach(() => {
    octokit = createMockOctokit();
    jest.clearAllMocks();
    // Reset mock implementations after clearAllMocks clears them
    upsertRepoFile.mockResolvedValue({});
    createConfigurationPR.mockResolvedValue({});
    _setConfigForTesting({
      dependabot: { version: 2, updates: [{ labels: ['dependencies'] }] }
    });
  });

  afterEach(() => {
    _setConfigForTesting({});
  });

  // ---------------------------------------------------------------------------
  // applyDependabotConfig
  // ---------------------------------------------------------------------------
  describe('applyDependabotConfig', () => {
    const depConfig = { version: 2, updates: [{ labels: ['dependencies'] }] };

    it('applies config via direct commit when use_pull_requests is false', async () => {
      _setConfigForTesting({
        change_strategy: { use_pull_requests: false }
      });

      await applyDependabotConfig(octokit, 'owner', 'repo', depConfig);

      expect(upsertRepoFile).toHaveBeenCalledWith(
        octokit,
        'owner',
        'repo',
        '.github/dependabot.yml',
        yaml.dump(depConfig),
        'Add/Update Dependabot configuration'
      );
      expect(createConfigurationPR).not.toHaveBeenCalled();
    });

    it('uses upsertRepoFile by default when change_strategy is not configured', async () => {
      _setConfigForTesting({});

      await applyDependabotConfig(octokit, 'owner', 'repo', depConfig);

      expect(upsertRepoFile).toHaveBeenCalledWith(
        octokit,
        'owner',
        'repo',
        '.github/dependabot.yml',
        yaml.dump(depConfig),
        'Add/Update Dependabot configuration'
      );
      expect(createConfigurationPR).not.toHaveBeenCalled();
    });

    it('applies config via PR when use_pull_requests is true', async () => {
      _setConfigForTesting({
        change_strategy: { use_pull_requests: true }
      });

      await applyDependabotConfig(octokit, 'owner', 'repo', depConfig);

      expect(createConfigurationPR).toHaveBeenCalledWith(
        octokit,
        'owner',
        'repo',
        '.github/dependabot.yml',
        yaml.dump(depConfig),
        'Update Dependabot configuration'
      );
      expect(upsertRepoFile).not.toHaveBeenCalled();
    });

    it('logs info messages on success', async () => {
      _setConfigForTesting({});

      await applyDependabotConfig(octokit, 'owner', 'repo', depConfig);

      expect(getLogger().info).toHaveBeenCalledWith(
        expect.stringContaining('Applying Dependabot configuration to owner/repo')
      );
      expect(getLogger().info).toHaveBeenCalledWith(
        expect.stringContaining('Applied Dependabot configuration to owner/repo')
      );
    });

    it('throws and logs error when upsertRepoFile fails', async () => {
      _setConfigForTesting({});
      upsertRepoFile.mockRejectedValue(new Error('Permission denied'));

      await expect(
        applyDependabotConfig(octokit, 'owner', 'repo', depConfig)
      ).rejects.toThrow('Permission denied');

      expect(getLogger().error).toHaveBeenCalledWith(
        expect.stringContaining('Error applying Dependabot configuration to owner/repo'),
        'Permission denied'
      );
    });

    it('throws and logs error when createConfigurationPR fails', async () => {
      _setConfigForTesting({
        change_strategy: { use_pull_requests: true }
      });
      createConfigurationPR.mockRejectedValue(new Error('Branch conflict'));

      await expect(
        applyDependabotConfig(octokit, 'owner', 'repo', depConfig)
      ).rejects.toThrow('Branch conflict');

      expect(getLogger().error).toHaveBeenCalledWith(
        expect.stringContaining('Error applying Dependabot configuration to owner/repo'),
        'Branch conflict'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // checkExistingDependabotConfig
  // ---------------------------------------------------------------------------
  describe('checkExistingDependabotConfig', () => {
    it('returns exists:false when 404', async () => {
      octokit.request.mockRejectedValue({ status: 404 });

      const result = await checkExistingDependabotConfig(octokit, 'o', 'r');

      expect(result.exists).toBe(false);
      expect(result.currentConfig).toBeNull();
      expect(result.matchesTarget).toBe(false);
      expect(result.labelIssues).toEqual([]);
      expect(result.dependabotPRCount).toBe(0);
    });

    it('detects matching config', async () => {
      const targetConfig = { version: 2, updates: [{ labels: ['dependencies'] }] };
      const b64 = encodeConfig(targetConfig);

      octokit.request.mockResolvedValue({ data: { content: b64 } });
      octokit.paginate.mockResolvedValue([]);

      const result = await checkExistingDependabotConfig(octokit, 'o', 'r');

      expect(result.exists).toBe(true);
      expect(result.matchesTarget).toBe(true);
    });

    it('detects mismatching config', async () => {
      const differentConfig = { version: 2, updates: [{ labels: ['other'] }] };
      const b64 = encodeConfig(differentConfig);

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

    it('uses fallback labels from target config when current config has no labels', async () => {
      // Current config in repo has no labels defined in updates
      const currentConfig = { version: 2, updates: [{ 'package-ecosystem': 'npm', directory: '/' }] };
      const b64 = encodeConfig(currentConfig);

      // Target config has labels
      _setConfigForTesting({
        dependabot: { version: 2, updates: [{ labels: ['dependencies'] }] }
      });

      octokit.request.mockResolvedValue({ data: { content: b64 } });
      // PR missing the fallback label
      octokit.paginate.mockResolvedValue([
        { number: 20, pull_request: {}, labels: [] }
      ]);

      const result = await checkExistingDependabotConfig(octokit, 'o', 'r');

      expect(result.labelIssues).toHaveLength(1);
      expect(result.labelIssues[0].number).toBe(20);
      expect(result.labelIssues[0].missingLabels).toEqual(['dependencies']);
    });

    it('returns empty labelIssues when all PRs have correct labels', async () => {
      const configYaml = yaml.dump({ version: 2, updates: [{ labels: ['dependencies'] }] });
      const b64 = Buffer.from(configYaml).toString('base64');

      octokit.request.mockResolvedValue({ data: { content: b64 } });
      octokit.paginate.mockResolvedValue([
        { number: 10, pull_request: {}, labels: [{ name: 'dependencies' }] },
        { number: 11, pull_request: {}, labels: [{ name: 'dependencies' }, { name: 'extra' }] }
      ]);

      const result = await checkExistingDependabotConfig(octokit, 'o', 'r');

      expect(result.labelIssues).toEqual([]);
      expect(result.dependabotPRCount).toBe(2);
    });

    it('throws on non-404 error from octokit.request', async () => {
      const serverError = new Error('Internal Server Error');
      serverError.status = 500;
      octokit.request.mockRejectedValue(serverError);

      await expect(
        checkExistingDependabotConfig(octokit, 'o', 'r')
      ).rejects.toThrow('Internal Server Error');

      expect(getLogger().error).toHaveBeenCalledWith(
        expect.stringContaining('Error checking existing Dependabot configuration'),
        'Internal Server Error'
      );
    });

    it('reports multiple missing labels across multiple PRs', async () => {
      const configYaml = yaml.dump({
        version: 2,
        updates: [{ labels: ['dependencies', 'automation'] }]
      });
      const b64 = Buffer.from(configYaml).toString('base64');

      _setConfigForTesting({
        dependabot: { version: 2, updates: [{ labels: ['dependencies', 'automation'] }] }
      });

      octokit.request.mockResolvedValue({ data: { content: b64 } });
      octokit.paginate.mockResolvedValue([
        { number: 1, pull_request: {}, labels: [] },
        { number: 2, pull_request: {}, labels: [{ name: 'dependencies' }] },
        { number: 3, pull_request: {}, labels: [{ name: 'dependencies' }, { name: 'automation' }] }
      ]);

      const result = await checkExistingDependabotConfig(octokit, 'o', 'r');

      expect(result.labelIssues).toHaveLength(2);
      // PR #1 missing both labels
      expect(result.labelIssues[0]).toEqual({
        number: 1,
        missingLabels: ['dependencies', 'automation']
      });
      // PR #2 missing 'automation'
      expect(result.labelIssues[1]).toEqual({
        number: 2,
        missingLabels: ['automation']
      });
      expect(result.dependabotPRCount).toBe(3);
    });
  });

  // ---------------------------------------------------------------------------
  // fixDependabotPRLabels
  // ---------------------------------------------------------------------------
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
      const issues = [{ number: 5, missingLabels: ['dependencies', 'automation'] }];

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

    it('logs info for each fixed PR', async () => {
      const issues = [
        { number: 7, missingLabels: ['dependencies'] },
        { number: 8, missingLabels: ['automation', 'bot'] }
      ];

      await fixDependabotPRLabels(octokit, 'o', 'r', issues);

      expect(getLogger().info).toHaveBeenCalledWith(
        expect.stringContaining('Fixing labels for 2 Dependabot PRs')
      );
      expect(getLogger().info).toHaveBeenCalledWith(
        expect.stringContaining('Added missing labels to PR #7: dependencies')
      );
      expect(getLogger().info).toHaveBeenCalledWith(
        expect.stringContaining('Added missing labels to PR #8: automation, bot')
      );
    });

    it('throws and logs error when octokit.request fails', async () => {
      octokit.request.mockRejectedValue(new Error('Rate limit exceeded'));
      const issues = [{ number: 1, missingLabels: ['dependencies'] }];

      await expect(
        fixDependabotPRLabels(octokit, 'o', 'r', issues)
      ).rejects.toThrow('Rate limit exceeded');

      expect(getLogger().error).toHaveBeenCalledWith(
        expect.stringContaining('Error fixing Dependabot PR labels'),
        'Rate limit exceeded'
      );
    });
  });

  // ---------------------------------------------------------------------------
  // checkDependabotConfiguration
  // ---------------------------------------------------------------------------
  describe('checkDependabotConfiguration', () => {
    it('generates report showing matching config', async () => {
      const targetConfig = { version: 2, updates: [{ labels: ['dependencies'] }] };
      const b64 = encodeConfig(targetConfig);

      octokit.request.mockResolvedValue({ data: { content: b64 } });
      octokit.paginate.mockResolvedValue([]);

      const report = await checkDependabotConfiguration(octokit, 'owner', 'repo');

      expect(report).toContain('## Dependabot Configuration Check for owner/repo');
      expect(report).toContain('### Current Configuration');
      expect(report).toContain('### Target Configuration');
      expect(report).toContain('Dependabot configuration matches target!');
      expect(report).toContain('All Dependabot PRs have correct labels.');
    });

    it('generates report showing mismatching config', async () => {
      const differentConfig = { version: 2, updates: [{ labels: ['other'] }] };
      const b64 = encodeConfig(differentConfig);

      octokit.request.mockResolvedValue({ data: { content: b64 } });
      octokit.paginate.mockResolvedValue([]);

      const report = await checkDependabotConfiguration(octokit, 'owner', 'repo');

      expect(report).toContain('## Dependabot Configuration Check for owner/repo');
      expect(report).toContain('### Current Configuration');
      expect(report).toContain('### Target Configuration');
      expect(report).toContain('Dependabot configuration differs from target');
      expect(report).toContain('/configure-repo');
    });

    it('includes label issues in report', async () => {
      const configYaml = { version: 2, updates: [{ labels: ['dependencies'] }] };
      const b64 = encodeConfig(configYaml);

      octokit.request.mockResolvedValue({ data: { content: b64 } });
      octokit.paginate.mockResolvedValue([
        { number: 42, pull_request: {}, labels: [] }
      ]);

      const report = await checkDependabotConfiguration(octokit, 'owner', 'repo');

      expect(report).toContain('### Dependabot PR Label Analysis');
      expect(report).toContain('Found 1 Dependabot PRs with missing labels');
      expect(report).toContain('PR #42');
      expect(report).toContain('Missing labels: dependencies');
      expect(report).toContain('/fix-dependabot-labels');
    });

    it('reports all labels correct when no issues exist', async () => {
      const targetConfig = { version: 2, updates: [{ labels: ['dependencies'] }] };
      const b64 = encodeConfig(targetConfig);

      octokit.request.mockResolvedValue({ data: { content: b64 } });
      octokit.paginate.mockResolvedValue([
        { number: 10, pull_request: {}, labels: [{ name: 'dependencies' }] }
      ]);

      const report = await checkDependabotConfiguration(octokit, 'owner', 'repo');

      expect(report).toContain('All Dependabot PRs have correct labels.');
    });

    it('returns 404 message when no dependabot config exists', async () => {
      octokit.request.mockRejectedValue({ status: 404 });

      const report = await checkDependabotConfiguration(octokit, 'owner', 'repo');

      expect(report).toContain('No Dependabot configuration found in owner/repo');
      expect(report).toContain('Target configuration should be applied');
    });

    it('returns error message on non-404 error', async () => {
      const serverError = new Error('Server error');
      serverError.status = 500;
      octokit.request.mockRejectedValue(serverError);

      const report = await checkDependabotConfiguration(octokit, 'owner', 'repo');

      expect(report).toContain('Error checking Dependabot configuration: Server error');
      expect(getLogger().error).toHaveBeenCalledWith(
        expect.stringContaining('Error checking Dependabot configuration for owner/repo'),
        'Server error'
      );
    });

    it('handles null currentConfig from empty YAML file', async () => {
      // An empty file yields null from yaml.load
      const b64 = Buffer.from('').toString('base64');

      // First call (line 144 in checkDependabotConfiguration): returns empty content
      // Second call (line 52 in checkExistingDependabotConfig): also returns empty content
      octokit.request.mockResolvedValue({ data: { content: b64 } });
      octokit.paginate.mockResolvedValue([]);

      const report = await checkDependabotConfiguration(octokit, 'owner', 'repo');

      // When currentConfig is falsy, the report says no config found
      expect(report).toContain('No Dependabot configuration found');
      expect(report).toContain('Target configuration should be applied');
    });

    it('includes multiple label issues in report', async () => {
      const configYaml = { version: 2, updates: [{ labels: ['dependencies', 'automation'] }] };
      const b64 = encodeConfig(configYaml);

      _setConfigForTesting({
        dependabot: { version: 2, updates: [{ labels: ['dependencies', 'automation'] }] }
      });

      octokit.request.mockResolvedValue({ data: { content: b64 } });
      octokit.paginate.mockResolvedValue([
        { number: 1, pull_request: {}, labels: [] },
        { number: 2, pull_request: {}, labels: [{ name: 'dependencies' }] }
      ]);

      const report = await checkDependabotConfiguration(octokit, 'owner', 'repo');

      expect(report).toContain('Found 2 Dependabot PRs with missing labels');
      expect(report).toContain('PR #1');
      expect(report).toContain('PR #2');
    });

    it('shows YAML blocks in report for existing config', async () => {
      const targetConfig = { version: 2, updates: [{ labels: ['dependencies'] }] };
      const b64 = encodeConfig(targetConfig);

      octokit.request.mockResolvedValue({ data: { content: b64 } });
      octokit.paginate.mockResolvedValue([]);

      const report = await checkDependabotConfiguration(octokit, 'owner', 'repo');

      // Verify the report contains YAML code blocks
      expect(report).toContain('```yaml');
      expect(report).toContain('```');
    });
  });

  // ---------------------------------------------------------------------------
  // buildDependabotYaml
  // ---------------------------------------------------------------------------
  describe('buildDependabotYaml', () => {
    it('builds config from ecosystems', () => {
      const ecosystems = [
        { ecosystem: 'npm', directory: '/' },
        { ecosystem: 'github-actions', directory: '/' }
      ];
      const result = buildDependabotYaml(ecosystems);

      expect(result.version).toBe(2);
      expect(result.updates).toHaveLength(2);
      expect(result.updates[0]['package-ecosystem']).toBe('npm');
      expect(result.updates[0].directory).toBe('/');
      expect(result.updates[0].schedule.interval).toBe('weekly');
      expect(result.updates[0].labels).toEqual(['dependencies']);
    });

    it('uses custom schedule and labels from genConfig', () => {
      const ecosystems = [{ ecosystem: 'cargo', directory: '/' }];
      const result = buildDependabotYaml(ecosystems, {
        default_schedule: 'daily',
        default_labels: ['deps', 'auto']
      });

      expect(result.updates[0].schedule.interval).toBe('daily');
      expect(result.updates[0].labels).toEqual(['deps', 'auto']);
    });

    it('handles empty ecosystems', () => {
      const result = buildDependabotYaml([]);
      expect(result.version).toBe(2);
      expect(result.updates).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // enhanceDependabotWithAI
  // ---------------------------------------------------------------------------
  describe('enhanceDependabotWithAI', () => {
    const baseConfig = {
      version: 2,
      updates: [{ 'package-ecosystem': 'npm', directory: '/', schedule: { interval: 'weekly' }, labels: ['dependencies'] }]
    };
    const aiConfig = { endpoint: 'http://localhost:8080/v1/chat/completions', model: 'test-model' };

    it('returns enhanced config from AI', async () => {
      const enhanced = {
        version: 2,
        updates: [{ 'package-ecosystem': 'npm', directory: '/', schedule: { interval: 'daily' }, labels: ['dependencies'], groups: { minor: { 'update-types': ['minor', 'patch'] } } }]
      };
      callLocalAI.mockResolvedValue(yaml.dump(enhanced));

      const result = await enhanceDependabotWithAI(baseConfig, ['package.json'], aiConfig);

      expect(result.version).toBe(2);
      expect(result.updates[0].schedule.interval).toBe('daily');
      expect(callLocalAI).toHaveBeenCalled();
    });

    it('falls back to base config when AI returns empty response', async () => {
      callLocalAI.mockResolvedValue('');

      const result = await enhanceDependabotWithAI(baseConfig, ['package.json'], aiConfig);
      expect(result).toEqual(baseConfig);
    });

    it('falls back to base config when AI returns invalid YAML', async () => {
      callLocalAI.mockResolvedValue('this is not yaml: [[[');

      const result = await enhanceDependabotWithAI(baseConfig, ['package.json'], aiConfig);
      expect(result).toEqual(baseConfig);
    });

    it('falls back to base config when AI returns wrong version', async () => {
      callLocalAI.mockResolvedValue(yaml.dump({ version: 1, updates: [] }));

      const result = await enhanceDependabotWithAI(baseConfig, ['package.json'], aiConfig);
      expect(result).toEqual(baseConfig);
    });

    it('falls back to base config when AI returns unknown ecosystem', async () => {
      const bad = {
        version: 2,
        updates: [{ 'package-ecosystem': 'fake-ecosystem', directory: '/', schedule: { interval: 'weekly' } }]
      };
      callLocalAI.mockResolvedValue(yaml.dump(bad));

      const result = await enhanceDependabotWithAI(baseConfig, ['package.json'], aiConfig);
      expect(result).toEqual(baseConfig);
    });

    it('falls back to base config when AI call throws', async () => {
      callLocalAI.mockRejectedValue(new Error('AI timeout'));

      const result = await enhanceDependabotWithAI(baseConfig, ['package.json'], aiConfig);
      expect(result).toEqual(baseConfig);
    });
  });

  // ---------------------------------------------------------------------------
  // extractLabelsFromConfig
  // ---------------------------------------------------------------------------
  describe('extractLabelsFromConfig', () => {
    it('returns unique labels from all update entries', () => {
      const result = extractLabelsFromConfig({
        version: 2,
        updates: [
          { 'package-ecosystem': 'npm', labels: ['dependencies', 'javascript'] },
          { 'package-ecosystem': 'docker', labels: ['dependencies', 'docker'] }
        ]
      });
      expect(result).toEqual(expect.arrayContaining(['dependencies', 'javascript', 'docker']));
      expect(result).toHaveLength(3);
    });

    it('returns empty array for missing config', () => {
      expect(extractLabelsFromConfig(null)).toEqual([]);
      expect(extractLabelsFromConfig(undefined)).toEqual([]);
    });

    it('returns empty array for config without updates', () => {
      expect(extractLabelsFromConfig({ version: 2 })).toEqual([]);
      expect(extractLabelsFromConfig({})).toEqual([]);
    });

    it('skips updates without labels', () => {
      const result = extractLabelsFromConfig({
        updates: [
          { 'package-ecosystem': 'npm', directory: '/' },
          { 'package-ecosystem': 'docker', labels: ['docker'] }
        ]
      });
      expect(result).toEqual(['docker']);
    });
  });

  // ---------------------------------------------------------------------------
  // generateDependabotConfig
  // ---------------------------------------------------------------------------
  describe('generateDependabotConfig', () => {
    it('generates config from file tree', async () => {
      _setConfigForTesting({
        dependabot_generation: { enabled: true, default_schedule: 'weekly', default_labels: ['dependencies'] }
      });

      octokit.request.mockResolvedValue({
        data: {
          tree: [
            { path: 'package.json', type: 'blob' },
            { path: '.github/workflows/ci.yml', type: 'blob' },
            { path: 'src/index.js', type: 'blob' }
          ]
        }
      });

      const result = await generateDependabotConfig(octokit, 'owner', 'repo', 'main');

      expect(result.config).not.toBeNull();
      expect(result.config.version).toBe(2);
      expect(result.ecosystems).toHaveLength(2);
      expect(result.report).toContain('npm');
      expect(result.report).toContain('github-actions');
    });

    it('returns null config when no ecosystems detected', async () => {
      _setConfigForTesting({
        dependabot_generation: { enabled: true }
      });

      octokit.request.mockResolvedValue({
        data: {
          tree: [
            { path: 'README.md', type: 'blob' },
            { path: 'LICENSE', type: 'blob' }
          ]
        }
      });

      const result = await generateDependabotConfig(octokit, 'owner', 'repo', 'main');

      expect(result.config).toBeNull();
      expect(result.ecosystems).toEqual([]);
    });

    it('throws on API error', async () => {
      _setConfigForTesting({ dependabot_generation: {} });
      octokit.request.mockRejectedValue(new Error('API error'));

      await expect(
        generateDependabotConfig(octokit, 'owner', 'repo', 'main')
      ).rejects.toThrow('API error');
    });

    it('skips tree entries that are not blobs', async () => {
      _setConfigForTesting({ dependabot_generation: {} });

      octokit.request.mockResolvedValue({
        data: {
          tree: [
            { path: 'package.json', type: 'blob' },
            { path: 'src', type: 'tree' }
          ]
        }
      });

      const result = await generateDependabotConfig(octokit, 'owner', 'repo', 'main');
      expect(result.ecosystems).toHaveLength(1);
      expect(result.ecosystems[0].ecosystem).toBe('npm');
    });
  });
});
