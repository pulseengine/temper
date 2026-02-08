import { validateConfig } from '../../src/schema.js';

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
});
