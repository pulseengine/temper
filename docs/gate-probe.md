# Skipped required checks must fail closed

GitHub counts a skipped job as a passing required check, and an aggregate gate
with `if: always()` often accepts "skipped" as well. So the path filters and
change detectors in front of a required check decide what is gated. A filter
that lists what counts as code fails open: a new kind of input is silently
ungated. One that lists what is *not* code, and treats everything else as code,
fails closed.

temper checks this in two halves. Both are report-only today; making the probe
a required check is a later, per-repo step applied by smithy after the owner
approves.

## Static check (temper's standards sweep)

`src/gate-skip.js` reads each repo's workflow files and its required checks and
reports a `gate_skip` finding (`npm run plan`; `standards.drift` in
temper-report.v1):

| rule | means |
|---|---|
| `paths_ignore_dir_wildcard` | a required workflow ignores `dir/**`, which matches every file type under `dir` |
| `paths_allowlist` | a required workflow runs only on listed `paths`, and its stub passes everything else |
| `stub_mismatch` | a not-applicable stub's `paths` is not exactly the real workflow's `paths-ignore` (or the reverse) |
| `aggregate_accepts_skip` | an `if: always()` gate needs a job a detector can skip, and never reads the detector's result |
| `detector_unprobed` | a required check can be skipped by a change detector the repo has not declared for the probe |

A stub is told from the real workflow by step count: the real one does the work.

## Behavioural probe (`.github/actions/gate-probe`)

Reading a detector cannot show which way it fails; running it can. The repo
declares its detectors in `.github/gate-probe.json`:

```json
{
  "version": 1,
  "detectors": [
    { "command": ["tools/ci/detect-changes.sh"], "outputs": ["rust"], "controls": [] }
  ]
}
```

For each control path the probe runs `command` (repo-relative, no shell) with:

- `GATE_PROBE_FILES`: a file listing the changed paths, one per line. The
  detector must read its changed files from here when the variable is set.
- `GITHUB_OUTPUT`: a fresh file the detector writes `key=value` lines to.
- No other environment: no tokens, no secrets.

Every name in `outputs` must come back `true` for the default controls
(`docs/gate-probe-control.rs`, `supply-chain/gate-probe-control.toml`,
`gate-probe-new-dir/control.bin`) and for the repo's own `controls`. Exit 0
means every detector fails closed, 1 means one fails open, and 2 means the
contract is missing or invalid or a detector did not run. The probe fails
closed in that case too.

A workflow that runs it (smithy's runner constraints apply):

```yaml
name: gate-probe
on:
  pull_request:
permissions:
  contents: read
jobs:
  gate-probe:
    runs-on: [self-hosted, light]
    steps:
      - uses: actions/checkout@<sha>
        with:
          persist-credentials: false
      - uses: pulseengine/temper/.github/actions/gate-probe@<temper sha>
```

The check name `gate-probe` must stay stable: renaming a required check
silently drops the requirement. Fixes inside a repo belong to that repo.
