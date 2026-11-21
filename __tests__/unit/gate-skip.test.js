import { analyzeGateSkips, remoteReusableCalls } from '../../src/gate-skip.js';

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

describe('the gate-probe workflow itself must never skip', () => {
  const SHA = 'd075376b198aac85966a2d51346593d83835394b';
  const probeWf = ({ on = 'pull_request:', jobIf = '', stepExtra = '', ref = SHA } = {}) => wf('gate-probe.yml', `
name: gate-probe
on:
  ${on}
permissions:
  contents: read
jobs:
  gate-probe:
    runs-on: [self-hosted, light]
${jobIf ? `    if: ${jobIf}\n` : ''}    steps:
      - uses: actions/checkout@${SHA}
      - uses: pulseengine/temper/.github/actions/gate-probe@${ref}
${stepExtra}`);

  it('positive control: an unfiltered, sha-pinned probe workflow passes', () => {
    expect(analyzeGateSkips([probeWf()], ['gate-probe'])).toEqual([]);
  });

  it('a public repo must route fork PRs off self-hosted runners', () => {
    const plain = analyzeGateSkips([probeWf()], [], { publicRepo: true });
    expect(plain).toHaveLength(1);
    expect(plain[0].detail).toContain('self-hosted runs-on without fork routing');
    const routed = probeWf();
    routed.text = routed.text.replace('runs-on: [self-hosted, light]',
      `runs-on: \${{ github.event.pull_request.head.repo.fork && 'ubuntu-latest' || fromJSON('["self-hosted","light"]') }}`);
    expect(analyzeGateSkips([routed], [], { publicRepo: true })).toEqual([]);
    // the four-label form the repos use (spar#615, meld#587, gale#487, rivet#1219)
    const four = probeWf();
    four.text = four.text.replace('runs-on: [self-hosted, light]',
      `runs-on: \${{ github.event.pull_request.head.repo.fork && 'ubuntu-latest' || fromJSON('["self-hosted","linux","x64","light"]') }}`);
    expect(four.text).toContain('"linux","x64"');
    expect(analyzeGateSkips([four], [], { publicRepo: true })).toEqual([]);
    // a private repo has no fork PRs from outside: the plain label is fine
    expect(analyzeGateSkips([probeWf()], [], { publicRepo: false })).toEqual([]);
  });

  it('a job timeout is allowed (gale requires one on every job)', () => {
    const w = probeWf();
    w.text = w.text.replace('    runs-on: [self-hosted, light]\n', '    runs-on: [self-hosted, light]\n    timeout-minutes: 10\n');
    expect(w.text).toContain('timeout-minutes: 10');
    expect(analyzeGateSkips([w], ['gate-probe'])).toEqual([]);
  });

  it.each([
    ['paths filter', { on: "pull_request:\n    paths: ['src/**']" }, 'pull_request.paths'],
    ['paths-ignore', { on: "pull_request:\n    paths-ignore: ['**/*.md']" }, 'pull_request.paths-ignore'],
    ['branch filter', { on: 'pull_request:\n    branches: [main]' }, 'pull_request.branches'],
    ['pull_request_target', { on: 'pull_request_target:' }, 'pull_request_target trigger'],
    ['job if', { jobIf: "github.actor != 'dependabot[bot]'" }, 'job if:'],
    ['step if', { stepExtra: "        if: github.event.pull_request.draft == false\n" }, 'step if:'],
    ['continue-on-error', { stepExtra: '        continue-on-error: true\n' }, 'continue-on-error'],
    ['tag ref', { ref: 'v1' }, 'action ref is not a full sha']
  ])('flags %s', (_what, opts, problem) => {
    const hits = analyzeGateSkips([probeWf(opts)], []);
    expect(hits).toHaveLength(1);
    expect(hits[0].rule).toBe('probe_workflow_skippable');
    expect(hits[0].detail).toContain(problem);
  });
});

describe('tiered detectors: every gating output is probed or exempted', () => {
  const TIERED = wf('ci.yml', `
name: CI
on: [pull_request]
jobs:
  changes:
    runs-on: x
    steps: [{ run: detect }]
  test:
    name: Test
    needs: changes
    if: needs.changes.outputs.tests == 'true'
    runs-on: x
    steps: [{ run: cargo test }]
  matrix:
    name: Matrix
    needs: changes
    if: needs.changes.outputs.rust == 'true'
    runs-on: x
    steps: [{ run: cargo build }]
`);
  const contract = (d) => JSON.stringify({ version: 1, detectors: [{ command: ['detect'], negative_controls: ['README.md'], ...d }] });

  it('an output that gates a required check but is not declared is flagged', () => {
    const hits = analyzeGateSkips([TIERED], ['Test', 'Matrix'], { probeContract: contract({ outputs: ['tests'] }) });
    expect(hits).toEqual([{ rule: 'output_unprobed', workflow: '.github/workflows/ci.yml', job: 'matrix',
      detail: 'gated by rust, neither probed nor exempted in .github/gate-probe.json' }]);
  });

  it('a reasoned exemption covers it; an empty reason does not', () => {
    expect(analyzeGateSkips([TIERED], ['Test', 'Matrix'],
      { probeContract: contract({ outputs: ['tests'], exempt_outputs: { rust: 'data-tier changes skip the matrix (owner, rivet#1211)' } }) })).toEqual([]);
    expect(rules(analyzeGateSkips([TIERED], ['Test', 'Matrix'],
      { probeContract: contract({ outputs: ['tests'], exempt_outputs: { rust: ' ' } }) }))).toEqual(['output_unprobed']);
  });

  it('declaring both outputs covers both', () => {
    expect(analyzeGateSkips([TIERED], ['Test', 'Matrix'], { probeContract: contract({ outputs: ['tests', 'rust'] }) })).toEqual([]);
  });

  it('an unreadable contract counts as no contract', () => {
    const hits = analyzeGateSkips([TIERED], ['Test'], { probeContract: '{ not json' });
    expect(hits).toEqual([{ rule: 'detector_unprobed', workflow: '.github/workflows/ci.yml', job: 'test',
      detail: 'skippable by changes; .github/gate-probe.json is not valid JSON' }]);
  });
});

// temper#100: a reusable-workflow check is named "<caller> / <called>"
// (jig's "required / verdict"). Shapes follow jig's ci.yml + required.yml.
describe('reusable workflows: "<caller> / <called>" contexts', () => {
  const REQUIRED = wf('required.yml', `
name: required
on:
  workflow_call:
    inputs:
      results: { type: string, required: true }
jobs:
  verdict:
    name: verdict
    runs-on: ubuntu-latest
    steps:
      - run: echo '\${{ inputs.results }}' | jig verdict
`);
  const CALLER = (extra = '', { needs = '[test]', ifExpr = 'always()', withResults = '${{ toJSON(needs) }}' } = {}) => wf('ci.yml', `
name: CI
on: [pull_request]
jobs:
${extra}
  test:
    name: test
    runs-on: ubuntu-latest
    steps: [{ run: cargo test }]
  required:
    needs: ${needs}
    if: ${ifExpr}
    uses: ./.github/workflows/required.yml
    with:
      results: "${withResults}"
`);
  const CHANGES = `
  changes:
    runs-on: ubuntu-latest
    outputs: { rust: x }
    steps: [{ run: detect }]
`;

  it('positive control: jig\'s shape is matched and clean', () => {
    expect(analyzeGateSkips([CALLER(), REQUIRED], ['required / verdict'], { probeContract: true })).toEqual([]);
  });

  it('planted: a gate that accepts a detector-skipped job without reading the detector is flagged', () => {
    const extra = `${CHANGES}  build:
    needs: changes
    if: needs.changes.outputs.rust == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: make }]`;
    const hits = analyzeGateSkips([CALLER(extra, { needs: '[test, build]', withResults: 'none' }), REQUIRED],
      ['required / verdict'], { probeContract: true });
    expect(hits).toEqual([{ rule: 'aggregate_accepts_skip', workflow: '.github/workflows/ci.yml', job: 'required/verdict',
      detail: 'accepts skipped build without reading changes' }]);
    // Reading the detector's result in what the caller passes closes it.
    const read = analyzeGateSkips([CALLER(extra, { needs: '[test, build, changes]', withResults: '${{ needs.changes.result }}' }), REQUIRED],
      ['required / verdict'], { probeContract: true });
    expect(read).toEqual([]);
  });

  it('planted: a verdict whose caller is gated on a detector output needs the probe contract', () => {
    const hits = analyzeGateSkips([CALLER(CHANGES, { needs: '[test, changes]', ifExpr: "needs.changes.outputs.rust == 'true'" }), REQUIRED],
      ['required / verdict']);
    expect(rules(hits)).toEqual(['detector_unprobed']);
    expect(hits[0].job).toBe('required/verdict');
  });

  it('the called workflow alone does not produce the context', () => {
    expect(rules(analyzeGateSkips([REQUIRED], ['required / verdict']))).toEqual(['required_unmatched']);
  });

  it('required_unmatched: a remote reusable call and a missing Actions check are reported; another app\'s status is not', () => {
    const remote = wf('ci.yml', `
on: [pull_request]
jobs:
  required:
    uses: pulseengine/jig/.github/workflows/required.yml@${'a'.repeat(40)}
`);
    const hits = analyzeGateSkips([remote], ['required / verdict', 'lint', 'codecov/patch'], { actionsContexts: ['lint'] });
    expect(hits.map((h) => [h.rule, h.detail.match(/"(.*)"/)[1]])).toEqual([
      ['required_unmatched', 'required / verdict'],
      ['required_unmatched', 'lint']
    ]);
  });
});

describe('remote reusable workflows (temper#103)', () => {
  const SHA = 'b'.repeat(40);
  const USES = `pulseengine/jig/.github/workflows/required.yml@${SHA}`;
  const REQUIRED_TEXT = `
name: required
on:
  workflow_call:
    inputs:
      results: { type: string, required: true }
jobs:
  verdict:
    name: verdict
    runs-on: ubuntu-latest
    steps:
      - run: echo '\${{ inputs.results }}' | jig verdict
`;
  const caller = (uses, { extra = '', needs = '[test]', withResults = '${{ toJSON(needs) }}' } = {}) => wf('ci.yml', `
name: CI
on: [pull_request]
jobs:
${extra}
  test:
    name: test
    runs-on: ubuntu-latest
    steps: [{ run: cargo test }]
  required:
    needs: ${needs}
    if: always()
    uses: ${uses}
    with:
      results: "${withResults}"
`);
  const read = [{ uses: USES, text: REQUIRED_TEXT }];

  it('positive control: a same-org call pinned to a sha, read at the pin, is matched and clean', () => {
    expect(analyzeGateSkips([caller(USES)], ['required / verdict'], { probeContract: true, remoteWorkflows: read })).toEqual([]);
  });

  it('planted: the rules see through the remote call (accepting a detector-skipped job)', () => {
    const extra = `
  changes:
    runs-on: ubuntu-latest
    outputs: { rust: x }
    steps: [{ run: detect }]
  build:
    needs: changes
    if: needs.changes.outputs.rust == 'true'
    runs-on: ubuntu-latest
    steps: [{ run: make }]`;
    const hits = analyzeGateSkips([caller(USES, { extra, needs: '[test, build]', withResults: 'none' })],
      ['required / verdict'], { probeContract: true, remoteWorkflows: read });
    expect(hits).toEqual([{ rule: 'aggregate_accepts_skip', workflow: '.github/workflows/ci.yml', job: 'required/verdict',
      detail: 'accepts skipped build without reading changes' }]);
  });

  it('a remote text is keyed by the exact uses string: another sha is not expanded from it', () => {
    const other = USES.replace(SHA, 'c'.repeat(40));
    const hits = analyzeGateSkips([caller(other)], ['required / verdict'], { remoteWorkflows: read });
    expect(rules(hits)).toEqual(['required_unmatched']);
    expect(hits[0].detail).toContain(`${other}: not read`);
  });

  it('a remote text is not analysed as a workflow of this repository', () => {
    // Its own job "verdict" must not satisfy a required Actions context of this repo.
    expect(rules(analyzeGateSkips([], ['verdict'], { actionsContexts: ['verdict'], remoteWorkflows: read }))).toEqual(['required_unmatched']);
  });

  it('required_unmatched names why a remote call was not expanded', () => {
    const detail = (uses, remoteWorkflows) =>
      analyzeGateSkips([caller(uses)], ['required / verdict'], { remoteWorkflows })[0].detail;
    const tag = 'pulseengine/jig/.github/workflows/required.yml@v1';
    expect(detail(tag, remoteReusableCalls([caller(tag)], 'pulseengine').map(({ uses, reason }) => ({ uses, reason }))))
      .toContain('ref "v1" is not a full commit sha');
    expect(detail(USES, [{ uses: USES, reason: 'could not be read at the pin (status 404)' }])).toContain('status 404');
    const renamed = [{ uses: USES, text: REQUIRED_TEXT.replace('name: verdict', 'name: decide') }];
    expect(detail(USES, renamed)).toContain('none of its jobs produces this name');
  });

  it('remoteReusableCalls: only same-org, full-sha calls are fetchable; local calls are not listed', () => {
    const files = [caller(USES), wf('b.yml', `
on: [push]
jobs:
  a: { uses: pulseengine/jig/.github/workflows/required.yml@main }
  b: { uses: evil/jig/.github/workflows/required.yml@${SHA} }
  c: { uses: ./.github/workflows/local.yml }
  d: { uses: ${USES} }
  e: { uses: pulseengine/jig/.github/workflows/required.yml@${'B'.repeat(40)} }
`)];
    expect(remoteReusableCalls(files, 'PulseEngine').map((c) => [c.uses.split('@')[1].slice(0, 4), c.owner, c.fetchable, c.reason ?? ''])).toEqual([
      ['bbbb', 'pulseengine', true, ''],
      ['main', 'pulseengine', false, 'ref "main" is not a full commit sha, so it is not read'],
      ['bbbb', 'evil', false, 'another org (evil) is not read'],
      ['BBBB', 'pulseengine', false, `ref "${'B'.repeat(40)}" is not a full commit sha, so it is not read`]
    ]);
  });
});
