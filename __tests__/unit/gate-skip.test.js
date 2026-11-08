import { analyzeGateSkips } from '../../src/gate-skip.js';

const wf = (path, text) => ({ path: `.github/workflows/${path}`, text });
const rules = (hits) => hits.map((h) => h.rule).sort();

const REAL_IGNORE = (ignore) => wf('ci.yml', `
name: CI
on:
  pull_request:
    paths-ignore: [${ignore.map((p) => `'${p}'`).join(', ')}]
jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: cargo test
`);
const STUB_PATHS = (paths) => wf('ci-stub.yml', `
name: CI (stub)
on:
  pull_request:
    paths: [${paths.map((p) => `'${p}'`).join(', ')}]
jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - run: echo not applicable
`);

describe('paths filters', () => {
  it('positive control: file-type ignores with a matching stub pass', () => {
    const p = ['**/*.md', 'safety/**/*.yaml', '!meld-cli/docs/**'];
    expect(analyzeGateSkips([REAL_IGNORE(p), STUB_PATHS(p)], ['Test'])).toEqual([]);
  });

  it('a bare dir/** ignore on a required workflow is flagged', () => {
    const p = ['**/*.md', 'safety/**'];
    const hits = analyzeGateSkips([REAL_IGNORE(p), STUB_PATHS(p)], ['Test']);
    expect(hits).toEqual([{ rule: 'paths_ignore_dir_wildcard', workflow: '.github/workflows/ci.yml', detail: 'paths-ignore safety/**' }]);
  });

  it('an ignore on a workflow that produces no required check is not flagged', () => {
    expect(analyzeGateSkips([REAL_IGNORE(['safety/**'])], ['Other'])).toEqual([]);
  });

  it('a stub whose paths differ from the real paths-ignore is flagged once', () => {
    const hits = analyzeGateSkips([REAL_IGNORE(['**/*.md', 'tools/*.py']), STUB_PATHS(['**/*.md'])], ['Test']);
    expect(rules(hits)).toEqual(['stub_mismatch']);
  });

  it('a required workflow that runs only on listed paths is flagged; its paths-ignore stub is not', () => {
    const real = wf('proofs.yml', `
name: Rocq proofs
on:
  pull_request:
    paths: ['proofs/**', 'MODULE.bazel']
jobs:
  proofs:
    name: Rocq proofs
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: bazel test //proofs/...
`);
    const stub = wf('proofs-stub.yml', `
name: Rocq proofs (stub)
on:
  pull_request:
    paths-ignore: ['proofs/**', 'MODULE.bazel']
jobs:
  proofs:
    name: Rocq proofs
    runs-on: ubuntu-latest
    steps:
      - run: echo n/a
`);
    expect(analyzeGateSkips([real, stub], ['Rocq proofs'])).toEqual([
      { rule: 'paths_allowlist', workflow: '.github/workflows/proofs.yml', detail: 'runs only on 2 listed path(s)' }
    ]);
  });
});

const DETECTOR_CI = (gateRun, gateIf = 'always()') => wf('ci.yml', `
name: CI
on: [pull_request]
jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      rust: \${{ steps.d.outputs.rust }}
    steps:
      - id: d
        run: tools/ci/detect-changes.sh
  test:
    needs: changes
    if: needs.changes.outputs.rust == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: cargo test
  gate:
    name: CI Gate
    needs: [changes, test]
    if: ${gateIf}
    runs-on: ubuntu-latest
    steps:
      - run: ${gateRun}
`);

describe('detector-skipped required checks', () => {
  it('a gate that accepts a skip without reading the detector is flagged', () => {
    const hits = analyzeGateSkips([DETECTOR_CI(`test "\${{ needs.test.result }}" != failure`)], ['CI Gate'], { probeContract: true });
    expect(hits).toEqual([{ rule: 'aggregate_accepts_skip', workflow: '.github/workflows/ci.yml', job: 'gate',
      detail: 'accepts skipped test without reading changes' }]);
  });

  it('positive control: a gate that checks the detector succeeded passes', () => {
    const run = `test "\${{ needs.changes.result }}" = success && test "\${{ needs.test.result }}" != failure`;
    expect(analyzeGateSkips([DETECTOR_CI(run)], ['CI Gate'], { probeContract: true })).toEqual([]);
  });

  it('a detector-skippable required check needs the probe contract', () => {
    const run = `test "\${{ needs.changes.result }}" = success`;
    expect(rules(analyzeGateSkips([DETECTOR_CI(run)], ['CI Gate']))).toEqual(['detector_unprobed']);
    expect(rules(analyzeGateSkips([DETECTOR_CI(run)], ['test']))).toEqual(['detector_unprobed']);
  });

  it('a gate without always() is not an aggregate that accepts skips', () => {
    expect(analyzeGateSkips([DETECTOR_CI('true', 'success()')], ['CI Gate'], { probeContract: true })).toEqual([]);
  });

  it('matrix job names match their required contexts', () => {
    const m = wf('ci.yml', `
on: [pull_request]
jobs:
  changes:
    runs-on: ubuntu-latest
    steps: [{ run: 'true' }]
  test:
    name: Test (\${{ matrix.label }})
    needs: changes
    if: needs.changes.outputs.rust == 'true'
    strategy: { matrix: { label: [linux, macos] } }
    runs-on: ubuntu-latest
    steps: [{ run: cargo test }]
`);
    expect(rules(analyzeGateSkips([m], ['Test (macos)']))).toEqual(['detector_unprobed']);
  });

  it('unparsable workflow files are ignored, not fatal', () => {
    expect(analyzeGateSkips([wf('bad.yml', ': : :\n  - [')], ['Test'])).toEqual([]);
  });
});
