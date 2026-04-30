# Temper — prioritized bug list (wave-1 fleet output)

Findings from 13 specialist agents (one pending). Each has a file:line citation
and at least one wave-1 agent flag. Severity tiers:

- 🔴 **Critical** — destructive, exploitable, or trust-boundary
- 🟠 **High** — silent wrongness, lost work, audit-trail gap
- 🟡 **Medium** — quality, performance, hygiene
- 🟢 **Low** — polish

Sort: severity, then independent-flagger count, then ease-of-fix.

---

## 🔴 Critical

### 1. `synchronizeIssueLabels` silently deletes user-created labels (`src/labels.js:69-78`)
Runs on every `repository.created`, every `/sync-all-repos`, every
`/configure-repo`, every `reconcile-repo` task. Any label not in `config.yml
issue_labels` is destroyed. Open issues lose their tags. **There is no opt-out
and no preserve-list.** Single `/sync-all-repos` invocation triggers this
across every repo in the org.
- **Flagged by:** QA bug-hunter (#1)
- **Fix:** add `synchronize_mode: 'merge' | 'replace'` (default `'merge'` —
  only create/update; never delete). Behind a config flag for explicit
  opt-in to destructive sync.

### 2. `WEBHOOK_SECRET` fail-open default
Probot defaults the webhook secret to literal `"development"` when the env var
is unset. `index.js` and `mapLegacyEnvVars` (`src/app.js:1136-1149`) don't
fail-fast on missing secret. A misconfigured deploy silently accepts forged
webhooks signed with `"development"`.
- **Flagged by:** Security auditor (#1 high)
- **Fix:** in `index.js` before `await run(registerApp)`:
  ```js
  if (!process.env.WEBHOOK_SECRET || process.env.WEBHOOK_SECRET === 'development') {
    throw new Error('WEBHOOK_SECRET is required and cannot equal "development"');
  }
  ```

### 3. Dashboard POST routes are unauthenticated (`src/dashboard.js:1287-1495`)
`POST /dashboard/actions/sync`, `/actions/review`, `/actions/analyze-org`, and
JSON APIs `/api/org/repos`, `/api/org/health` are reachable without auth. Any
caller able to hit the bot's port can trigger org-wide reconfiguration or
exfiltrate repo data.
- **Flagged by:** Security auditor (#3 high)
- **Fix:** Bearer / shared-secret middleware for all `/dashboard/*` and
  `/api/*` routes; or bind to `127.0.0.1` only behind an authenticating
  reverse proxy.

### 4. `issues.opened` provisioning lacks the auth gate (`src/app.js:327-417`)
Comment-driven commands enforce `requireOrgMember` + `allowed_command_users`.
The issue-form provisioning path (controller_repo) doesn't. Anyone able to
file a labelled issue in the controller repo provisions a real org repo.
- **Flagged by:** Security auditor (#2 high)
- **Fix:** add the same allowlist + org-member check before
  `enqueueTask('provision-repo', ...)`.

### 5. Two SQLite connections to the same `dedup.db` (`src/app.js:1039-1047`)
`initKVStore` is called twice (idempotency + ai_rate_limits) against the same
file. WAL tolerates multi-connection reads, but writes from two connections
can `SQLITE_BUSY` outside a single transaction. When `markProcessed` and
`recordReview` race, one throws → handler crashes mid-flight → `markProcessed`
skipped → **same delivery is reprocessed and the AI review runs twice.**
- **Flagged by:** QA bug-hunter (#3 critical)
- **Fix:** share one `Database` connection between the two KV instances.

---

## 🟠 High

### 6. Chatops handler doesn't `markProcessed` on early returns or exceptions
`handleChatopsIssue` early-returns on auth failure / missing fields without
`markProcessed`. Exception during `closeIssue()` after `commentBack()`
succeeded leaves the wrapping handler unable to mark the delivery — Probot
retries → **duplicate analysis-report issues, duplicate auth-rejection
comments**. Same pattern for `/check-config`, `/sync-all-repos`,
`/allow-merge-commit`.
- **Flagged by:** QA bug-hunter (#2 critical)
- **Fix:** `try/finally` wrapping with `markProcessed` always, plus
  idempotency via dedup key on the action itself.

### 7. `success: true` returned when configuration silently degraded
- `applyBranchEnforcement` falls back to legacy on rulesets 422/403/404
  silently (`src/repository.js:30-58`).
- `setRequiredSignatures` swallows 404/422 with a `warn`
  (`src/branch-protection.js:55-62`).
- Result: `configureRepository` returns `{success: true}` even when signed
  commits aren't enforced and no rulesets are applied.
- **Flagged by:** Safety-critical architect (#1, structural), QA, DevOps
- **Fix:** read-back-and-assert pattern. After applying, fetch the actual
  state and assert it matches the desired set. Surface mismatches as
  `{success: false, missing: [...]}`. Emit a GitHub Check Run on the repo's
  default branch with conclusion `failure` so an org-required check refuses
  merges until the bot succeeds.

### 8. `/health` always returns 200 (`src/app.js:984+`)
Returns `status: 'healthy'` unconditionally. Scheduler stuck, SQLite locked,
AI endpoint dead, disk full: all return 200. PM2 never restarts on hang.
- **Flagged by:** DevOps/SRE (#1 critical), Safety-critical architect
- **Fix:** Real liveness signal: scheduler last-tick-age threshold, DB ping,
  free-disk threshold, last-error counter. Return 503 on any. Wire to PM2
  `--max-memory-restart` and external uptime monitor.

### 9. Inline AI review on `pull_request.opened` is not durable (`src/app.js:840-929`)
Auto AI review runs in the webhook handler with no task-store enqueue. PM2
restart mid-`reviewPullRequest` = silent loss. Same for the `enableAutoMerge`
mutation. Compare to `provision-repo`, `generate-dependabot`,
`revert-merge-settings`, `reconcile-repo` which ARE durable.
- **Flagged by:** DevOps/SRE, Performance, Safety architect
- **Fix:** enqueue `auto-review` and `auto-enable-merge` tasks; webhook
  handler returns within ~50 ms.

### 10. `reviews.json` non-atomic full-rewrite (`src/ai-review.js:622-651`)
`fs.writeFileSync(REVIEWS_PATH, JSON.stringify(_reviews))` on every review.
If process killed mid-write the file is truncated → next `loadReviews()`
swallows via bare `catch {}` (line 631) → **all review history silently
resets to `[]`.**
- **Flagged by:** QA, Performance, DevOps
- **Fix:** replace with a SQLite table next to `tasks.db`. Append, never
  rewrite. Bonus: add tamper-evidence (SHA chain) for the audit-trail claim
  the safety architect flagged.

### 11. Test mock retrofit hides production bugs (`__tests__/integration/{ai-review,app}.test.js`)
`createMockOctokit` retrofits `octokit.issues.X` jest.fn()s over the real
`octokit.request` route table. **Production code that calls `.issues.X` passes
tests and crashes in prod.** This is exactly the PR #22 / #29 / #34 regression
class still active. The smoke `webhook.test.js` accepts `[200, 202, 401, 500]`
for `issue_comment.created`, swallowing the very 500 a `.issues` call would
produce.
- **Flagged by:** Test-quality engineer, Senior reviewer (pending)
- **Fix:** replace with a "real-shape" octokit fake exposing only `.request()`
  and `.paginate()` — Probot v14's actual surface. Tighten e2e to `[200, 202]`
  only.

### 12. Slop regex too greedy (`src/ai-review-prompt.js:65+`)
`\b(could|should|may|consider)\b` drops legitimate findings:
- "this **could** panic on null deref at line 42"
- "function **should** not be called from async context"
- "**Consider**[ed]" — `\bconsider\s+/` kills "the constructor doesn't consider the empty-list case"
Quote-or-die `String.includes` is whitespace-fragile (CRLF/tab normalisation).
Schema accepts `quoted_line: "+"` (1-char minimum) — every diff has `+`.
- **Flagged by:** LLM prompt engineer
- **Fix:** convert single-word patterns to phrase patterns ("we should
  consider", "might be wise to"). Normalise whitespace before quote check.
  Tighten schema: `quoted_line` `pattern: "^[+-].+"`, `claim minLength: 30`.

### 13. `pull_request.opened` has no idempotency guard (`src/app.js:840+`)
Only the 5-min AI rate limit prevents duplicate auto-reviews on webhook
redelivery. `enablePullRequestAutoMerge` GraphQL is called every time without
guard.
- **Flagged by:** QA bug-hunter
- **Fix:** standard `isProcessed`/`markProcessed` pattern at handler entry.

### 14. Self-update: no signature verification, no rollback
`src/self-update.js:6-28` spawns `tools/self-update/target/release/temper-self-update`
inheriting full env (line 21, `...process.env` leaks all secrets to child).
No SHA / signature check on the binary. `git reset --hard origin/main` is not
atomic with `npm ci`; if `npm ci` fails after reset, you're on new code with
old/partial deps and no rollback.
- **Flagged by:** Safety architect, DevOps
- **Fix:** snapshot SHA before reset, smoke `node -e "require('./index.js')"`
  before `pm2 restart`, auto-revert on failure. Verify a signed release tag
  before exec'ing the binary. Whitelist env vars passed to the child.

### 15. Tarball extraction lacks symlink/path-traversal safety (`src/rivet-fetch.js:48`)
`tar -xz --strip-components=1 -C destDir` — no `--no-same-owner`, no `-P`
rejection, no symlink guard. Malicious PR head ref can include a symlink
pointing outside `destDir`; subsequent `runRivetOracle` reads `rivet.yaml`
from that target.
- **Flagged by:** Security auditor (medium)
- **Fix:** drop symlinks via JS `tar` lib with `filter`, or `--no-overwrite-dir`
  + pre-validate entries.

---

## 🟡 Medium

### 16. Multiple `.repos.X` / `.pulls.X` calls in dashboard.js (PR #22 risk class)
`octokit.repos.get` (`dashboard.js:79`), `getCommitSignatureProtection` (:83),
`pulls.list` (:87), `getBranch` (:432), `compareCommits` (:440), `listBranches`
(:457), `actions.listWorkflowRunsForRepo` (:74), `checks.listForRef` (:103).
Plus `app.js:268` `context.octokit.repos.getBranch` — exact same shape as the
PR #22/#29/#34 saga.
- **Flagged by:** Probot/Octokit expert
- **Fix:** sweep these to `.request()` form. dashboard.js builds its own
  octokit (line 31), so the namespace IS reliable there — but app.js:268 is
  on `context.octokit` and shares the failure mode.

### 17. Documentation references npm scripts that don't exist
README.md:141-144 and DEVELOPMENT.md:230-233 list `npm run deploy:docker`,
`deploy:heroku`, `deploy:server`, `deploy:netcup`. Only `docker:build` exists
in package.json.
- **Flagged by:** Junior dev, Documentation reviewer
- **Fix:** delete the fictional scripts from docs OR add them to package.json.

### 18. GITHUB_APP_SETUP.md uses obsolete env var names
Uses `GITHUB_APP_ID`/`GITHUB_PRIVATE_KEY`/`GITHUB_WEBHOOK_SECRET` (legacy);
`.env.example` and DEVELOPMENT.md use the canonical `APP_ID`/`PRIVATE_KEY`/
`WEBHOOK_SECRET`. Junior devs copy whichever they read last.
- **Flagged by:** Junior dev, Documentation reviewer
- **Fix:** update GITHUB_APP_SETUP.md to canonical names.

### 19. Sequential GitHub fetches in `reviewPullRequest` (`src/ai-review.js:382-398`)
3 strictly sequential REST calls (PR meta, diff media-type, files): ~600-1500
ms before any work. Independent — could be `Promise.all`.
- **Flagged by:** Performance
- **Fix:** parallelise; saves 0.5-1 s per review.

### 20. Sequential rivet head + base validate (`src/ai-review.js:417-451`)
Two tarball fetches + two extracts + two rivet runs, sequentially. ~50%
wall-time savings if parallelised.
- **Flagged by:** Performance
- **Fix:** `Promise.all` the head and base oracle runs.

### 21. `synchronizeAllRepositories` no concurrency cap (`src/organization.js:34-52`)
Fully sequential `for...of`. ~30-60 s for 13 repos. With 100 repos it can
also exceed the 5000/h GitHub rate limit.
- **Flagged by:** Performance, Probot expert
- **Fix:** `p-limit(3)` bounded concurrency.

### 22. `provenance` job attests `package.json` only (`.github/workflows/ci.yml:75-92`)
Doesn't attest the Docker image, the self-update Rust binary, or the SBOM.
Actions pinned by tag (`@v4`, `@v0`), not commit SHA. `node:20-alpine` is a
floating tag.
- **Flagged by:** Supply-chain
- **Fix:** build actual artifacts, capture digests, feed digests into
  `attest-build-provenance@v2` and `attest-sbom@v2` as `subject-digest`.
  SHA-pin every action. Pin base image to digest.

### 23. `npm audit ... || true` swallows findings (`.github/workflows/ci.yml:21`)
Audit is advisory, not enforcing. Vulnerable deps merge to main without alarm.
- **Flagged by:** Supply-chain
- **Fix:** drop `|| true`. Set `--audit-level=high` if you want to allow
  moderate transitive findings.

### 24. eslint@8 is end-of-life
No security backports as of 2024-10. Quality gate against deprecated toolchain.
- **Flagged by:** Supply-chain
- **Fix:** migrate to eslint v9 (flat config) — sizable but isolated.

### 25. `provisioning.js` regex accepts invalid GitHub repo names
`REPO_NAME_RE = /^[a-zA-Z0-9._-]+$/` accepts `.`, `..`, `.git`, leading
dots, `-`, `--`. GitHub 422s on these; user sees generic "❌ Failed to
create repository".
- **Flagged by:** QA, Junior dev
- **Fix:** stricter regex; reject leading dots / dashes / `.git` suffix.

### 26. `_reviewTimestamps` in-memory Map grows unbounded (`src/ai-review.js:22`)
Dead code when persistent store wired; memory leak when not. No `cleanup()`.
- **Flagged by:** QA, DevOps
- **Fix:** delete the in-memory fallback now that SQLite KV is the canonical path.

### 27. `dependabot.js` order-sensitive equality check (`src/dependabot.js:108`)
`JSON.stringify(currentConfig) === JSON.stringify(targetConfig)` — yaml.load
preserves source order; identical configs in different key orders compare
unequal → unnecessary writes (and PRs when `use_pull_requests: true`).
- **Flagged by:** QA
- **Fix:** deep-equal a normalised form, not stringified.

### 28. Module-level `loadConfig()` and `startAutoCleanup()` at import time
`src/config.js:82`, `src/idempotency.js:74`. Side effects at module import
make the bot untestable in isolation and prevent a "validated config or
refuse to start" boot policy.
- **Flagged by:** Safety architect, Senior reviewer
- **Fix:** explicit `init()` called from `index.js`; refuse to start on
  invalid config.

### 29. AI prompt-injection mitigation incomplete (`src/ai-review.js:68-71`)
`sanitizeAIOutput` only strips `::workflow-command::`. Doesn't redact
`<img>` HTML, mass `@mentions`, or fake "Approval" verdicts. PR diffs are
attacker-controlled.
- **Flagged by:** Security auditor (medium), LLM expert
- **Fix:** widen sanitizer; consider posting AI output as a quote block to
  prevent markdown rendering of model output.

### 30. Rivet binary version drift
Bot ships with rivet v0.4.3; rivet repo's main may use newer schema (this
already happened during dev). Conversion bugs become silent
"unknown→unknown" findings.
- **Flagged by:** Rivet expert
- **Fix:** on startup, run `rivet --version` and assert against a pinned
  `expected_rivet_version`. On mismatch, log loudly and disable the oracle.

---

## 🟢 Low

### 31. `CONTRIBUTING.md` links to non-existent `CODE_OF_CONDUCT.md`
- **Flagged by:** Junior dev, Documentation
- **Fix:** add the file or remove the link.

### 32. `CHANGELOG.md` migration guide tells users to install probot v12, octokit v19
`package.json` ships probot v14, octokit v22.
- **Flagged by:** Documentation
- **Fix:** delete the outdated migration block.

### 33. `verify-netcup-deployment.sh` is a printf script with no enforcement
Every check is informational; only missing-files exits non-zero. Suggests
`node index.js &` with no PM2.
- **Flagged by:** DevOps
- **Fix:** make checks enforcing or delete; commit `ecosystem.config.js`
  for PM2 instead.

### 34. No `LICENSE` file at repo root; `package.json` declares MIT
18 BSD-3 + 12 Apache-2.0 transitive deps require attribution that the
repo doesn't carry.
- **Flagged by:** Supply-chain
- **Fix:** add LICENSE + NOTICE.

### 35. Probot v14 events not subscribed but should be
- `pull_request.synchronize` — bot doesn't re-review on force-push (10-line fix)
- `pull_request.reopened` — symmetrical to `.opened`
- `pull_request_review` / `pull_request_review_comment` — bot can't react to
  human reviews
- `check_run.rerequested` — would let `/review-pr` be triggered from Checks UI
- `installation.created` / `installation_repositories.added` — could replace
  manual `/sync-all-repos` flow
- **Flagged by:** Probot/Octokit expert

---

## What's NOT here

- The senior code reviewer's report wasn't in when this was written. When it
  arrives, fold into the relevant categories above (likely module-cohesion
  and complexity hotspots, which the safety architect already covered).
- Wave-2 will add new findings as fixes are attempted (and surface bugs
  in fixes themselves).

---

## Action priorities for the human

If only one PR this week: **#1 (label deletion)**. It's destructive, runs
on every webhook, and the fix is small.

If two: add **#2 (`WEBHOOK_SECRET` fail-fast)**. One line; closes a real
trust boundary.

If three: add **#11 (real-shape octokit test fake)**. Single change that
prevents the entire PR-22 regression class from ever shipping again.

If a sprint: 1, 2, 4, 5, 7, 8, 9 — covers destructive, trust, audit-trail,
liveness in one sweep.
