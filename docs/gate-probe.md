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
| `output_unprobed` | a detector output that gates a required check is in neither `outputs` nor `exempt_outputs` |
| `probe_workflow_skippable` | the workflow that runs the probe has a `pull_request` filter, an `if:`, `continue-on-error`, `pull_request_target`, or a non-sha action ref |

A stub is told from the real workflow by step count: the real one does the work.

## Behavioural probe (`.github/actions/gate-probe`)

Reading a detector cannot show which way it fails; running it can. The repo
declares its detectors in `.github/gate-probe.json`:

```json
{
  "version": 1,
  "detectors": [
    { "command": ["tools/ci/detect-changes.sh"], "outputs": ["rust"],
      "negative_controls": ["docs/architecture.md"], "controls": [],
      "exempt_outputs": { "rust": "data-tier changes skip the full matrix (owner)" } }
  ]
}
```

For each control path the probe runs `command` (repo-relative, no shell) with:

- `GATE_PROBE_FILES`: a file listing the changed paths, one per line. The
  detector must read its changed files from here when the variable is set.
- `GITHUB_OUTPUT`: a fresh file the detector writes `key=value` lines to.
- `EVENT_NAME` and `GITHUB_EVENT_NAME`: `pull_request`, as in a real PR.
- No other environment: no tokens, no secrets.

Every name in `outputs` must come back `true` for the default controls
(`docs/gate-probe-control.rs`, `supply-chain/gate-probe-control.toml`,
`gate-probe-new-dir/control.bin`) and for the repo's own `controls`.

A tiered detector declares in `outputs` the tier that gates the
always-required checks, because every declared output must be `true` for
every control. Any other output that gates a required check goes in
`exempt_outputs` with a reason. rivet's `rust` tier, for example, is false on
`supply-chain/` by the owner's choice, so rivet declares `tests` and exempts
`rust`. The probe does not run exempt outputs. temper's static check reports
an output that gates a required check and is in neither list as
`output_unprobed`, so a hidden tier shows up as a reasoned exemption.

A probe that cannot go red proves nothing. A detector that answers `true` for
everything, for example because it runs every job on an unknown event, would
pass those controls without classifying a single file. So `negative_controls` is
required: a non-empty list of real paths in the repo that the detector must
classify as not code. Every output must come back `false` for each of them.
Otherwise the probe reports `VACUOUS` ("classification not exercised") and
fails.

Controls are read only from `.github/gate-probe.json`; the action takes no
inputs. Never write a control path anywhere else in a tracked file, least of
all in workflow YAML or a probe workflow. Some detectors count a file as code
when another file references it (varve treats a `.md` as code if its basename
appears in `*.rs`, `.github/workflows/*` or `tools/*`), so naming a negative
control there would silently turn it into code.

The contract file is itself such a reference. A detector that searches the
tree for references MUST exclude `.github/gate-probe.json` from that search,
the same way it excludes itself. Otherwise listing a negative control makes
the detector count it as code, and the probe reports VACUOUS for a detector
that does discriminate (seen in gale).

Exit 0 means every detector fails closed and was exercised. 1 means one fails
open or was not exercised. 2 means the contract is missing or invalid or a
detector did not run, and the probe fails closed in that case too.

A workflow that runs it (smithy's runner constraints apply):

```yaml
name: gate-probe
on:
  pull_request:
permissions:
  contents: read
jobs:
  gate-probe:
    # Public repos: fork PRs run on GitHub-hosted, never on our hosts.
    runs-on: ${{ github.event.pull_request.head.repo.fork && 'ubuntu-latest' || fromJSON('["self-hosted","light"]') }}
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@<sha>
        with:
          persist-credentials: false
      - uses: pulseengine/temper/.github/actions/gate-probe@<temper sha>
```

The probe's own workflow is held to the rule it checks. A required check that
never reports keeps the PR pending, so a missing probe already fails closed.
A **skipped** probe reports success, and that is the hole. The probe workflow
therefore:

- MUST trigger on `pull_request` with no `paths`, `paths-ignore`, `branches`
  or `branches-ignore` filter;
- MUST NOT have an `if:` on the job or on the probe step, or a
  `continue-on-error`;
- MUST NOT use `pull_request_target`;
- MUST pin the action to a full 40-character temper commit sha;
- MUST run with `permissions: contents: read` on `[self-hosted, light]`;
- in a public repo MUST route fork PRs to a GitHub-hosted runner with the
  `head.repo.fork` expression above. The probe runs the PR's own detector
  script, and the runner group admits public repos. A fork can edit this
  line, so this is defence in depth: fork-PR approval
  (`all_external_contributors`) remains the gate. The job still runs on
  every PR, so it is never skipped. temper reports a self-hosted `runs-on`
  without fork routing in a public repo as `probe_workflow_skippable`;
- SHOULD set `timeout-minutes` so a hung detector cannot hold a required
  check pending (a timeout is allowed and is not a skip).

temper's `gate_skip` finding reports the first four as
`probe_workflow_skippable`. The runner and permissions are checked by
smithy's phase-2 dry run.

The check name `gate-probe` must stay stable: renaming a required check
silently drops the requirement. Fixes inside a repo belong to that repo.
