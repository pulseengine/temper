/**
 * Smoke tests: verify every module loads without errors and exports
 * the expected symbols.  No mocks — these import the real code.
 *
 * src/ modules are imported directly (babel-jest handles the transform).
 * index.js and functions.js pull in probot (52+ ESM-only transitive deps)
 * which cannot be transformed by babel-jest, so they are verified via a
 * real Node.js subprocess.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

describe('src module imports', () => {
  it('src/helpers.js exports expected functions', async () => {
    const mod = await import('../../src/helpers.js');
    expect(typeof mod.normalizeRepoInput).toBe('function');
    expect(typeof mod.getDefaultBranch).toBe('function');
    expect(typeof mod.isForkRepo).toBe('function');
  });

  it('src/config.js exports expected functions and constants', async () => {
    const mod = await import('../../src/config.js');
    expect(typeof mod.getConfig).toBe('function');
    expect(typeof mod.getMergeSettings).toBe('function');
    expect(typeof mod.getBranchProtectionConfig).toBe('function');
    expect(typeof mod.mergePullRequestRules).toBe('function');
    expect(typeof mod.getRequiredSignaturesFlag).toBe('function');
    expect(typeof mod.getDependabotLabels).toBe('function');
    expect(typeof mod.getTargetIssueLabels).toBe('function');
    expect(typeof mod._setConfigForTesting).toBe('function');
    expect(mod.DEFAULT_MERGE_SETTINGS).toBeDefined();
  });

  it('src/logger.js exports expected functions', async () => {
    const mod = await import('../../src/logger.js');
    expect(typeof mod.getLogger).toBe('function');
    expect(typeof mod.setLogger).toBe('function');
    expect(typeof mod.resetLogger).toBe('function');
    expect(mod.defaultLogger).toBeDefined();
  });

  it('src/github-api.js exports expected functions', async () => {
    const mod = await import('../../src/github-api.js');
    expect(typeof mod.upsertRepoFile).toBe('function');
    expect(typeof mod.createConfigurationPR).toBe('function');
  });

  it('src/branch-protection.js exports expected functions', async () => {
    const mod = await import('../../src/branch-protection.js');
    expect(typeof mod.applyBranchProtection).toBe('function');
    expect(typeof mod.setRequiredSignatures).toBe('function');
  });

  it('src/templates.js exports expected functions', async () => {
    const mod = await import('../../src/templates.js');
    expect(typeof mod.applyTemplates).toBe('function');
    expect(typeof mod.applyCodeowners).toBe('function');
  });

  it('src/labels.js exports expected functions', async () => {
    const mod = await import('../../src/labels.js');
    expect(typeof mod.synchronizeIssueLabels).toBe('function');
  });

  it('src/dependabot.js exports expected functions', async () => {
    const mod = await import('../../src/dependabot.js');
    expect(typeof mod.applyDependabotConfig).toBe('function');
    expect(typeof mod.checkExistingDependabotConfig).toBe('function');
    expect(typeof mod.fixDependabotPRLabels).toBe('function');
    expect(typeof mod.checkDependabotConfiguration).toBe('function');
  });

  it('src/repository.js exports expected functions', async () => {
    const mod = await import('../../src/repository.js');
    expect(typeof mod.configureRepository).toBe('function');
  });

  it('src/organization.js exports expected functions', async () => {
    const mod = await import('../../src/organization.js');
    expect(typeof mod.checkOrganizationMembership).toBe('function');
    expect(typeof mod.synchronizeAllRepositories).toBe('function');
    expect(typeof mod.analyzeOrganizationRepositories).toBe('function');
    expect(typeof mod.generateOrganizationAnalysisReport).toBe('function');
  });

  it('src/merge-strategy.js exports expected functions', async () => {
    const mod = await import('../../src/merge-strategy.js');
    expect(typeof mod.handleSignedCommitMerge).toBe('function');
    expect(typeof mod.checkPRMergeStrategy).toBe('function');
  });

  it('src/reporting.js exports expected functions', async () => {
    const mod = await import('../../src/reporting.js');
    expect(typeof mod.generateConfigurationReport).toBe('function');
    expect(typeof mod.verifyCIAttestation).toBe('function');
  });

  it('src/ai-review.js exports expected functions', async () => {
    const mod = await import('../../src/ai-review.js');
    expect(typeof mod.reviewPullRequest).toBe('function');
    expect(typeof mod.buildReviewPrompt).toBe('function');
    expect(typeof mod.formatReviewComment).toBe('function');
    expect(typeof mod.callLocalAI).toBe('function');
    expect(typeof mod.isLocalEndpoint).toBe('function');
  });

  it('src/app.js exports expected functions', async () => {
    const mod = await import('../../src/app.js');
    expect(typeof mod.registerApp).toBe('function');
    expect(typeof mod.mapLegacyEnvVars).toBe('function');
  });

  it('src/idempotency.js exports expected functions', async () => {
    const mod = await import('../../src/idempotency.js');
    expect(typeof mod.isProcessed).toBe('function');
    expect(typeof mod.markProcessed).toBe('function');
    expect(typeof mod.cleanup).toBe('function');
    expect(typeof mod.stopAutoCleanup).toBe('function');
  });

  it('src/queue.js exports expected class and instance', async () => {
    const mod = await import('../../src/queue.js');
    expect(typeof mod.JobQueue).toBe('function');
    expect(mod.defaultQueue).toBeInstanceOf(mod.JobQueue);
    expect(typeof mod.defaultQueue.enqueue).toBe('function');
    expect(typeof mod.defaultQueue.stats).toBe('function');
  });

  it('src/retry.js exports expected functions', async () => {
    const mod = await import('../../src/retry.js');
    expect(typeof mod.withRetry).toBe('function');
  });

  it('src/schema.js exports expected functions', async () => {
    const mod = await import('../../src/schema.js');
    expect(typeof mod.validateConfig).toBe('function');
  });

  it('src/middleware.js exports expected functions', async () => {
    const mod = await import('../../src/middleware.js');
    expect(typeof mod.applySecurityMiddleware).toBe('function');
  });
});

describe('entry point imports (Node.js subprocess)', () => {
  const nodeArgs = ['--input-type=module', '-e'];

  it('index.js loads and exports all public symbols', async () => {
    const script = `
      const mod = await import('./index.js');
      const expected = [
        'registerApp', 'configureRepository', 'applyBranchProtection',
        'applyTemplates', 'applyCodeowners', 'checkExistingDependabotConfig',
        'fixDependabotPRLabels', 'synchronizeIssueLabels', 'getTargetIssueLabels'
      ];
      const missing = expected.filter(k => typeof mod[k] !== 'function');
      if (missing.length) {
        console.error('Missing exports:', missing.join(', '));
        process.exit(1);
      }
      console.log('OK');
    `;
    const { stdout } = await execFileAsync('node', [...nodeArgs, script], {
      timeout: 15000,
      env: { ...process.env, LOG_LEVEL: 'silent' }
    });
    expect(stdout.trim()).toBe('OK');
  });

  it('functions.js re-exports match index.js', async () => {
    const script = `
      const mod = await import('./functions.js');
      const expected = [
        'configureRepository', 'applyBranchProtection', 'applyTemplates',
        'checkExistingDependabotConfig', 'fixDependabotPRLabels'
      ];
      const missing = expected.filter(k => typeof mod[k] !== 'function');
      if (missing.length) {
        console.error('Missing exports:', missing.join(', '));
        process.exit(1);
      }
      console.log('OK');
    `;
    const { stdout } = await execFileAsync('node', [...nodeArgs, script], {
      timeout: 15000,
      env: { ...process.env, LOG_LEVEL: 'silent' }
    });
    expect(stdout.trim()).toBe('OK');
  });
});
