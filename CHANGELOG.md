# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## Migration Guide

### From 0.x to 1.0

1. **Update package.json**
   ```bash
   npm install probot@^12.0.0 @octokit/rest@^19.0.0
   ```

2. **Update configuration**
   ```yaml
   # Update config.yml to match new format
   ```

3. **Review changes**
   - New merge settings format
   - Improved error handling
   - Better logging

### From 1.x to 2.0 (Future)

1. **Update dependencies**
   ```bash
   npm install probot@^13.0.0 @octokit/rest@^20.0.0
   ```

2. **Review breaking changes**
   - New configuration format
   - Updated API endpoints
   - New authentication method

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
