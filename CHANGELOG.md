# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — skipped required checks must fail closed (report only)
- `src/gate-skip.js` reads each repo's workflows and required checks. It
  reports `dir/**` ignores, `paths` allowlists, stub/real filter mismatches,
  `if: always()` gates that accept a skip without reading the detector, and
  detector-skippable required checks with no probe contract. The finding is
  `gate_skip` in the plan and `standards.drift` in temper-report.v1. The
  sweep now also reads each workflow file and `.github/gate-probe.json`.
- `.github/actions/gate-probe` runs each detector declared in
  `.github/gate-probe.json` on control paths (`docs/*.rs`, `supply-chain/`, a
  new top-level directory) and fails when one comes back as not-code. It is
  stdlib-only Python with a self-test in CI. See `docs/gate-probe.md`.

### Added — temper-report.v1 for warte
- `src/report.js` builds and validates `temper-report.v1` against the same
  rules as warte's parser (`src/temper/report.rs`): closed objects, no free
  text, caps of 500 repos, 40 checks per repo, 1 MiB. It writes the file
  atomically (tmp, fsync, rename, mode 0640). An invalid or oversized report
  never replaces the previous one.
- `src/report-sweep.js` evaluates every repo a sync would touch against the
  standards (read-only), every `report.sweep_interval_hours` (default 12).
  `last_sweep_at` moves only when a sweep completed and persists across
  restarts.
- `src/report-stats.js` counts API calls in the last hour from response
  headers, and AI review outcomes per UTC day (persisted).
- `TaskStore.getReportStats()` gives pending age and stale in_progress tasks.
- `config.yml` gains `report:` (enabled, path `/var/lib/temper/report.json`);
  `TEMPER_REPORT_PATH` overrides the path.

### Added — rivet traceability and the varve layer
- `varve.toml` pins realm `pulseengine`, layer `2026.11.0` (rivet 0.41.1);
  `varve-realms.toml` carries the realm's registry and trust root.
- `rivet.yaml` and `artifacts/`: STPA-Sec analysis (7 losses, 10 hazards,
  13 constraints, 8 controllers, 15 control actions, 13 UCAs, 12
  scenarios), 29 requirements (16 in v1.1.0, 9 in v1.2.0, 4 backlog),
  3 features, 6 verifications backed by existing tests.
- CI job `rivet`: installs varve v0.44.0 verified (cosign + sums), lays down
  the pinned layer, runs `rivet validate` and `rivet check bidirectional`.

### Added — AI review hardening (PR-A)
- **`src/ai-review-prompt.js`**: strict-JSON contract + parser + slop filter +
  quote-or-die + verdict-from-findings. New default for AI review on PRs.
  - System prompt forbids hedging words (`might`, `could`, `should`, etc.)
    and slop phrases ("ensure proper error handling", "consider edge cases",
    etc.) in finding claims.
  - `tryParseReview()` enforces a strict JSON shape — unknown verdict, null
    findings, missing fields all reject. No retries: silence is preferred to
    slop.
  - `filterFindings()` drops claims whose `quoted_line` doesn't appear
    verbatim in the diff (kills paraphrase/hallucination) or whose `claim`
    contains hedging.
  - `computeVerdict()` is deterministic: empty findings → `approve`; any
    finding → `comment`. The model's verdict field is advisory only.
  - When verdict is `approve` and findings are empty, the bot does NOT post
    — silence is better than a noisy "looks good" comment.
- Existing `ai_review.system_prompt` config still works as a back-door to the
  legacy freeform prompt for users who explicitly override it.

### Added
- **Repository Rulesets** support (`src/rulesets.js`). Branch protection now uses
  the modern Rulesets API (`POST /repos/{owner}/{repo}/rulesets`) which targets
  `~DEFAULT_BRANCH` instead of a specific branch. Eliminates the `repository.created`
  race condition on empty repos. Translates the existing `branch_protection.default`
  config block into a ruleset payload — no config rewrite required.
- **Issue-driven repo provisioning** (Cut A: Temper as the brain). New
  `issues.opened` handler watches a configured controller repo. When an issue
  with the `repo-request` label is filed, Temper parses the issue-form body,
  validates it, and enqueues a `provision-repo` task that creates the repo
  (template-based when requested), applies full configuration, and replies on
  the source issue. See `docs/controller-repo-template/` for the issue form
  starter.
- **Persistent task scheduler** wired from `registerApp` (was exported but
  never imported). The scheduler now uses an installation-token factory so each
  tick gets a fresh, installation-scoped Octokit. New task handlers:
  `revert-merge-settings`, `reconcile-repo`, `provision-repo`.
- **`docs/controller-repo-template/`** — starter for the controller repo with
  an issue-form schema (`new-repo.yml`). Operators fill in pulseengine-specific
  fields (license list, custom properties, default CODEOWNERS team).

### Changed
- **Empty-repo bootstrap** no longer skips configuration when the default branch
  is missing. Rulesets, merge settings, and labels are applied immediately;
  branch-scoped work (templates, codeowners, dependabot) is deferred to a
  `reconcile-repo` task that fires after the first push.
- **Idempotency and AI review rate limits** moved from in-memory `Map` to
  SQLite-backed KV (`src/persistent-kv.js`). Survives PM2 restarts — webhooks
  are no longer re-processed and PRs no longer re-reviewed after a deploy.
- **`handleSignedCommitMerge`** uses the persistent task store (with `delayMs`)
  for the 1-hour revert instead of `setTimeout`. The revert now survives a
  restart, eliminating the audit-violation case where the repo was left in
  the wrong merge mode after a process crash.
- `config.yml` gains `rulesets:` and `controller_repo:` sections (both opt-in
  via `enabled`).

### Fixed
- 5×2s retry race on `repository.created` for empty repositories.
- AI review rate limits and webhook idempotency no longer reset on restart.

## [1.0.0] - 2026-01-24

### Added
- Initial release of Temper
- Automatic repository configuration on creation
- Merge settings management (rebase-only, delete branches)
- Chatops support via `/configure-repo` command
- Issue documentation for configured repositories
- Comprehensive documentation
- Docker support
- Heroku deployment guide
- Development setup guide

### Features
- Real-time GitHub webhook processing
- Probot framework integration
- Octokit API client
- Environment variable configuration
- Error handling and logging
- MIT License

## [0.1.0] - 2026-01-23

### Added
- Initial project setup
- Basic Probot integration
- Repository configuration logic
- Initial documentation

---

## Migration Notes

The project currently ships **probot ^14.2.4** and **@octokit/rest ^22.0.1**
(see `package.json`). Earlier versions of this CHANGELOG carried a stale
"install probot@^12, @octokit/rest@^19" instruction that no longer matches
reality and has been removed.

When a migration is actually needed for a future release, a `### From X.x
to Y.0` block describing the concrete steps will be added here at the time
of that release.

## Deprecation Policy

- Features will be deprecated for at least one major version
- Deprecation warnings will be logged
- Migration guides will be provided

## Support Policy

- Latest major version: Full support
- Previous major version: Security fixes only
- Older versions: No support

---

**Note**: This changelog follows semantic versioning (MAJOR.MINOR.PATCH)
