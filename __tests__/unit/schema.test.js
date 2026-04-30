import { validateConfig } from '../../src/schema.js';
import { _setConfigForTesting, isControlSurfaceRepo } from '../../src/config.js';

describe('isControlSurfaceRepo', () => {
  beforeEach(() => { _setConfigForTesting({}); });
  afterEach(() => { _setConfigForTesting({}); });

  it('returns false when no chatops_repo / controller_repo configured', () => {
    expect(isControlSurfaceRepo('pulseengine/temper')).toBe(false);
  });

  it('matches chatops_repo.repo when enabled', () => {
    _setConfigForTesting({
      chatops_repo: { enabled: true, repo: 'pulseengine/temper-ops' }
    });
    expect(isControlSurfaceRepo('pulseengine/temper-ops')).toBe(true);
    expect(isControlSurfaceRepo('pulseengine/temper')).toBe(false);
  });

  it('does NOT match when chatops_repo is configured but disabled', () => {
    _setConfigForTesting({
      chatops_repo: { enabled: false, repo: 'pulseengine/temper-ops' }
    });
    expect(isControlSurfaceRepo('pulseengine/temper-ops')).toBe(false);
  });

  it('matches controller_repo.repo when enabled', () => {
    _setConfigForTesting({
      controller_repo: { enabled: true, repo: 'pulseengine/repo-requests' }
    });
    expect(isControlSurfaceRepo('pulseengine/repo-requests')).toBe(true);
  });

  it('handles non-string input safely', () => {
    expect(isControlSurfaceRepo(undefined)).toBe(false);
    expect(isControlSurfaceRepo(null)).toBe(false);
  });
});

describe('validateConfig', () => {
  it('accepts valid config', () => {
    const result = validateConfig({
      organization: 'my-org',
      settings: { merge: { allow_rebase_merge: true, allow_merge_commit: false } },
      issue_labels: [{ name: 'bug', color: 'd73a4a', description: 'Bug' }],
      dependabot: { version: 2 }
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects null config', () => {
    const result = validateConfig(null);
    expect(result.valid).toBe(false);
  });

  it('rejects empty organization', () => {
    const result = validateConfig({ organization: '' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('organization');
  });

  it('rejects non-boolean merge settings', () => {
    const result = validateConfig({
      settings: { merge: { allow_rebase_merge: 'yes' } }
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('allow_rebase_merge');
  });

  it('rejects non-array issue_labels', () => {
    const result = validateConfig({ issue_labels: 'bug' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('issue_labels');
  });

  it('rejects label without name', () => {
    const result = validateConfig({ issue_labels: [{ color: 'red' }] });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('name');
  });

  it('rejects non-number dependabot version', () => {
    const result = validateConfig({ dependabot: { version: '2' } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('dependabot.version');
  });

  it('validates ai_review temperature range', () => {
    const result = validateConfig({ ai_review: { enabled: true, temperature: 1.5 } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('temperature');
  });

  it('accepts valid temperature', () => {
    const result = validateConfig({ ai_review: { enabled: true, temperature: 0.3 } });
    expect(result.valid).toBe(true);
  });

  it('accepts valid self_update config', () => {
    const result = validateConfig({ self_update: { enabled: true, repo: 'temper', branch: 'main' } });
    expect(result.valid).toBe(true);
  });

  it('rejects non-boolean self_update.enabled', () => {
    const result = validateConfig({ self_update: { enabled: 'yes' } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('self_update.enabled');
  });

  it('rejects empty self_update.repo', () => {
    const result = validateConfig({ self_update: { repo: '' } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('self_update.repo');
  });

  it('rejects non-string self_update.branch', () => {
    const result = validateConfig({ self_update: { branch: 123 } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('self_update.branch');
  });

  it('rejects non-object self_update', () => {
    const result = validateConfig({ self_update: 'yes' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('self_update');
  });

  // dependabot_generation validation
  it('accepts valid dependabot_generation config', () => {
    const result = validateConfig({
      dependabot_generation: {
        enabled: true,
        ai_enhance: false,
        default_schedule: 'weekly',
        default_labels: ['dependencies'],
        max_directories_per_ecosystem: 5
      }
    });
    expect(result.valid).toBe(true);
  });

  it('rejects non-object dependabot_generation', () => {
    const result = validateConfig({ dependabot_generation: 'yes' });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('dependabot_generation');
  });

  it('rejects non-boolean dependabot_generation.enabled', () => {
    const result = validateConfig({ dependabot_generation: { enabled: 'true' } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('dependabot_generation.enabled');
  });

  it('rejects invalid dependabot_generation.default_schedule', () => {
    const result = validateConfig({ dependabot_generation: { default_schedule: 'hourly' } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('default_schedule');
  });

  it('rejects non-array dependabot_generation.default_labels', () => {
    const result = validateConfig({ dependabot_generation: { default_labels: 'deps' } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('default_labels');
  });

  it('rejects non-positive max_directories_per_ecosystem', () => {
    const result = validateConfig({ dependabot_generation: { max_directories_per_ecosystem: 0 } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('max_directories_per_ecosystem');
  });

  // scheduler validation
  it('accepts valid scheduler config', () => {
    const result = validateConfig({
      scheduler: { interval_minutes: 5, max_tasks_per_tick: 10, rate_limit_threshold: 100 }
    });
    expect(result.valid).toBe(true);
  });

  it('rejects non-object scheduler', () => {
    const result = validateConfig({ scheduler: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('scheduler');
  });

  it('rejects non-positive scheduler.interval_minutes', () => {
    const result = validateConfig({ scheduler: { interval_minutes: 0 } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('interval_minutes');
  });

  it('rejects non-positive scheduler.max_tasks_per_tick', () => {
    const result = validateConfig({ scheduler: { max_tasks_per_tick: -1 } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('max_tasks_per_tick');
  });

  it('rejects negative scheduler.rate_limit_threshold', () => {
    const result = validateConfig({ scheduler: { rate_limit_threshold: -5 } });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('rate_limit_threshold');
  });
});
