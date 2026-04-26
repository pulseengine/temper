jest.mock('../../src/logger.js', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { getLogger: () => log };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isRivetProject,
  runRivetValidate,
  runRivetImpact,
  runRivetOracle
} from '../../src/rivet-oracle.js';

function makeRunnerOk(stdout) {
  return jest.fn().mockResolvedValue({ stdout, stderr: '' });
}

function makeRunnerOkButExitNonZero(stdout) {
  // Mimic execFile behaviour: when child exits non-zero, the promise rejects
  // with an Error object that carries `stdout` and `code`.
  return jest.fn().mockRejectedValue(
    Object.assign(new Error('command exited 1'), { stdout, stderr: '', code: 1 })
  );
}

function makeRunnerSpawnFailure(message) {
  return jest.fn().mockRejectedValue(new Error(message));
}

describe('isRivetProject', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns true when rivet.yaml is at the root', () => {
    fs.writeFileSync(path.join(tmpDir, 'rivet.yaml'), 'project: x\n');
    expect(isRivetProject(tmpDir)).toBe(true);
  });

  it('returns false when no rivet.yaml exists', () => {
    expect(isRivetProject(tmpDir)).toBe(false);
  });

  it('returns false on a non-existent path', () => {
    expect(isRivetProject('/nonexistent/path/12345')).toBe(false);
  });
});

describe('runRivetValidate', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-test-'));
    fs.writeFileSync(path.join(tmpDir, 'rivet.yaml'), 'project: x\n');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleJson = JSON.stringify({
    command: 'validate',
    result: 'FAIL',
    errors: 2,
    warnings: 1,
    infos: 5,
    diagnostics: [
      { artifact_id: 'REQ-001', message: 'missing required field x', severity: 'error' },
      { artifact_id: 'REQ-002', message: 'unrecognised field', severity: 'warning' },
      { artifact_id: 'REQ-099', message: 'should have decision link', severity: 'info' },
      { artifact_id: 'REQ-005', message: 'broken schema', severity: 'error' }
    ],
    lifecycle_gaps: [
      { artifact_id: 'REQ-100', type: 'requirement', reason: 'no downstream artifacts found' }
    ],
    broken_cross_refs: [
      { from: 'REQ-200', to: 'DEC-200', reason: 'target does not exist' }
    ]
  });

  it('parses validate output and converts errors+warnings to findings (drops info)', async () => {
    const result = await runRivetValidate('/usr/bin/rivet', tmpDir, {
      runner: makeRunnerOk(sampleJson)
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe('FAIL');
    // 2 errors + 1 warning + 1 lifecycle_gap + 1 broken_cross_ref = 5 findings;
    // info dropped.
    expect(result.findings).toHaveLength(5);
    expect(result.findings.every((f) => f.severity !== 'info')).toBe(true);
    expect(result.findings.find((f) => f.artifact_id === 'REQ-099')).toBeUndefined();
  });

  it('still parses JSON when CLI exits non-zero (validate FAIL is the common case)', async () => {
    const result = await runRivetValidate('/usr/bin/rivet', tmpDir, {
      runner: makeRunnerOkButExitNonZero(sampleJson)
    });
    expect(result.ok).toBe(true);
    expect(result.result).toBe('FAIL');
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it('returns ok:false when CLI cannot be spawned', async () => {
    const result = await runRivetValidate('/usr/bin/rivet', tmpDir, {
      runner: makeRunnerSpawnFailure('ENOENT')
    });
    expect(result.ok).toBe(false);
  });

  it('returns ok:false on unparseable stdout', async () => {
    const result = await runRivetValidate('/usr/bin/rivet', tmpDir, {
      runner: makeRunnerOk('this is not json')
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/parseable JSON/);
  });

  it('rejects when target is not a rivet project', async () => {
    fs.rmSync(path.join(tmpDir, 'rivet.yaml'));
    const result = await runRivetValidate('/usr/bin/rivet', tmpDir, {
      runner: makeRunnerOk(sampleJson)
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not a rivet project/);
  });

  it('every finding includes the artifact_id and a non-hedging claim', async () => {
    const result = await runRivetValidate('/usr/bin/rivet', tmpDir, {
      runner: makeRunnerOk(sampleJson)
    });
    for (const f of result.findings) {
      expect(typeof f.artifact_id).toBe('string');
      expect(f.artifact_id.length).toBeGreaterThan(0);
      expect(f.claim).toContain(f.artifact_id);
      // Sanity: must not contain hedging language by construction
      expect(f.claim).not.toMatch(/might|could|may possibly/i);
    }
  });
});

describe('runRivetImpact', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-test-'));
    fs.writeFileSync(path.join(tmpDir, 'rivet.yaml'), 'project: x\n');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const sampleJson = JSON.stringify({
    command: 'impact',
    added: ['NEW-1', 'NEW-2'],
    removed: ['OLD-1'],
    changed: [{ id: 'CHG-1', summary: 'fields changed', title: 'Some artifact' }],
    directly_affected: [
      { id: 'AFF-1', depth: 1, reason: ['-> issued-by X'], title: 'Affected one' }
    ],
    transitively_affected: [
      { id: 'TRA-1', depth: 2, reason: ['-> blah'], title: '' },
      { id: 'TRA-2', depth: 3, reason: ['-> blah'], title: '' }
    ],
    summary: { added: 2, removed: 1, changed: 1, direct: 1, transitive: 2 }
  });

  it('surfaces removed + directly_affected, summarises transitive', async () => {
    const result = await runRivetImpact('/usr/bin/rivet', tmpDir, 'main', {
      runner: makeRunnerOk(sampleJson)
    });
    expect(result.ok).toBe(true);

    // 1 removed + 1 directly_affected + 1 transitive-summary = 3 findings.
    // We do NOT surface 'added' or 'changed' as findings — those are diff
    // metadata, not concerns.
    expect(result.findings).toHaveLength(3);

    const byId = Object.fromEntries(result.findings.map((f) => [f.artifact_id, f]));
    expect(byId['OLD-1']).toBeDefined();
    expect(byId['OLD-1'].claim).toMatch(/removed/i);
    expect(byId['AFF-1']).toBeDefined();
    expect(byId['<summary>']).toBeDefined();
    expect(byId['<summary>'].claim).toMatch(/2 additional artifacts/);
  });

  it('omits transitive summary when transitive list is empty', async () => {
    const empty = JSON.stringify({
      command: 'impact',
      added: [], removed: [], changed: [],
      directly_affected: [],
      transitively_affected: [],
      summary: { added: 0, removed: 0, changed: 0, direct: 0, transitive: 0 }
    });
    const result = await runRivetImpact('/usr/bin/rivet', tmpDir, 'main', {
      runner: makeRunnerOk(empty)
    });
    expect(result.findings).toHaveLength(0);
  });
});

describe('runRivetOracle', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rivet-test-'));
    fs.writeFileSync(path.join(tmpDir, 'rivet.yaml'), 'project: x\n');
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns applicable:false on non-rivet repo', async () => {
    fs.rmSync(path.join(tmpDir, 'rivet.yaml'));
    const r = await runRivetOracle('/usr/bin/rivet', tmpDir, {});
    expect(r.applicable).toBe(false);
  });

  it('runs validate only when no baseRef provided', async () => {
    const validateJson = JSON.stringify({
      command: 'validate', result: 'PASS',
      errors: 0, warnings: 0, infos: 0,
      diagnostics: [], lifecycle_gaps: [], broken_cross_refs: []
    });
    const runner = makeRunnerOk(validateJson);
    const r = await runRivetOracle('/usr/bin/rivet', tmpDir, { runner });
    expect(r.applicable).toBe(true);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(r.impact).toBeNull();
  });

  it('runs both validate and impact when baseRef provided', async () => {
    const validateJson = JSON.stringify({
      command: 'validate', result: 'PASS',
      errors: 0, warnings: 0, infos: 0,
      diagnostics: [], lifecycle_gaps: [], broken_cross_refs: []
    });
    const impactJson = JSON.stringify({
      command: 'impact',
      added: [], removed: [], changed: [],
      directly_affected: [], transitively_affected: [],
      summary: { added: 0, removed: 0, changed: 0, direct: 0, transitive: 0 }
    });
    const runner = jest.fn()
      .mockResolvedValueOnce({ stdout: validateJson, stderr: '' })
      .mockResolvedValueOnce({ stdout: impactJson, stderr: '' });
    const r = await runRivetOracle('/usr/bin/rivet', tmpDir, {
      baseRef: 'main',
      runner
    });
    expect(r.applicable).toBe(true);
    expect(runner).toHaveBeenCalledTimes(2);
    expect(r.impact).not.toBeNull();
  });

  it('returns ok:true even when one of the two oracles fails (degraded)', async () => {
    const validateJson = JSON.stringify({
      command: 'validate', result: 'PASS',
      errors: 0, warnings: 0, infos: 0,
      diagnostics: [], lifecycle_gaps: [], broken_cross_refs: []
    });
    const runner = jest.fn()
      .mockResolvedValueOnce({ stdout: validateJson, stderr: '' })
      .mockRejectedValueOnce(new Error('impact crashed'));
    const r = await runRivetOracle('/usr/bin/rivet', tmpDir, {
      baseRef: 'main',
      runner
    });
    expect(r.ok).toBe(true);
    expect(r.validate.result).toBe('PASS');
    expect(r.impact.error).toMatch(/impact crashed/);
  });
});
