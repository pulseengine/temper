// rivet 0.41+ reports lifecycle_gaps as a count and the gaps as
// lifecycle_coverage. The parser was written for 0.4.3's list and threw
// "number ... is not iterable" on every production PR once the oracle ran
// a current rivet (2026-11-20). Fixtures are real `rivet validate --format
// json` output on this repository, trimmed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runRivetValidate, runRivetImpact } from '../../src/rivet-oracle.js';

// A rivet project is any directory with rivet.yaml; the runner is mocked.
let REPO;
beforeAll(() => {
  REPO = fs.mkdtempSync(path.join(os.tmpdir(), 'temper-shape-'));
  fs.writeFileSync(path.join(REPO, 'rivet.yaml'), 'project: {}\n');
});
afterAll(() => fs.rmSync(REPO, { recursive: true, force: true }));
const fixture = (v) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', `rivet-${v}-validate.json`), 'utf8');

describe.each(['0.41.1', '0.42.2'])('runRivetValidate on rivet %s output', (version) => {
  it('turns lifecycle_coverage into findings and does not iterate the count', async () => {
    const data = JSON.parse(fixture(version));
    expect(typeof data.lifecycle_gaps).toBe('number');
    const r = await runRivetValidate('/x/rivet', REPO, {
      runner: jest.fn().mockResolvedValue({ stdout: fixture(version) })
    });
    expect(r.ok).toBe(true);
    const gaps = r.findings.filter((f) => /lifecycle coverage gap/.test(f.message));
    expect(gaps).toHaveLength(data.lifecycle_coverage.length);
    expect(gaps[0]).toMatchObject({
      artifact_id: data.lifecycle_coverage[0].artifact_id,
      message: `lifecycle coverage gap: no downstream ${data.lifecycle_coverage[0].missing.join(', ')}`
    });
    expect(gaps[0].claim).toContain(`(${data.lifecycle_coverage[0].artifact_type})`);
    expect(r.summary.lifecycle_gaps).toBe(data.lifecycle_coverage.length);
  });
});

describe('rivet output fields of an unexpected type', () => {
  it('validate: a count where a list was expected is ignored, not iterated', async () => {
    const stdout = JSON.stringify({
      result: 'PASS', diagnostics: 3, broken_cross_refs: 1, circular_dependencies: 2, lifecycle_gaps: 149
    });
    const r = await runRivetValidate('/x/rivet', REPO, { runner: jest.fn().mockResolvedValue({ stdout }) });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });
  it('impact: counts are ignored; removed may be ids or objects', async () => {
    const stdout = JSON.stringify({
      added: 1, changed: 2, directly_affected: 3, transitively_affected: 4,
      removed: ['REQ-1', { id: 'REQ-2' }]
    });
    const r = await runRivetImpact('/x/rivet', REPO, 'base', { runner: jest.fn().mockResolvedValue({ stdout }) });
    expect(r.ok).toBe(true);
    expect(r.findings.map((f) => f.artifact_id)).toEqual(['REQ-1', 'REQ-2']);
    expect(r.summary).toMatchObject({ added: 0, removed: 2, direct: 0, transitive: 0 });
  });
});
