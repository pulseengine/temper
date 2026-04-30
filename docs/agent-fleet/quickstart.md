# Temper — agent-fleet quickstart

Hand-off doc for wave-2 agents. Read this **before** investigating Temper for
the first time so you don't repeat work that 14 wave-1 agents already did.

## What Temper is, in one paragraph

Probot v14 (Node.js, ESM) GitHub App that hardens `pulseengine` org repos to a
declarative `config.yml`. Reacts to `repository.created`, `issue_comment.created`,
`issues.opened`, `pull_request.{opened,closed}`, and `push`. Persists state to
SQLite (`data/tasks.db`, `data/dedup.db`). Runs a 5-minute scheduler tick.
Deployed on a single Netcup VPS (3.8 GB RAM, 2 cores, no swap) under PM2 with
self-update on `push` to `main`. Talks to a local Ollama
(`qwen2.5-coder:3b`) for AI code review on PRs, and to a `rivet` CLI for
mechanical traceability oracle on `pulseengine/rivet`-instrumented repos.

## What's been verified to work (don't redesign these)

- **Repository Rulesets API is the right replacement** for legacy branch
  protection on empty repos (`src/rulesets.js`). The translator + drift
  detection works correctly when contexts are non-empty.
- **Persistent task store** (`src/task-store.js`) — atomic claim via
  `UPDATE ... RETURNING`, dedup by key, exponential backoff, 3-attempt cap.
- **Idempotency + AI rate-limit** moved to SQLite KV (`src/persistent-kv.js`,
  `src/idempotency.js`, `src/ai-review.js`). Survives PM2 restart.
- **AI review pipeline shape** — strict-JSON system prompt + grammar-constrained
  Ollama `response_format` + parser + slop filter + quote-or-die + deterministic
  `computeVerdict` is **the right architecture for a 3 B model**. Don't redesign.
- **Rivet oracle integration** — `runRivetValidate`, `runRivetImpact`,
  `subtractFindings` (delta vs base), `groupOracleFindings` (collapse identical
  messages). Tarball-fetch is side-effect-clean.
- **chatops_repo restriction** — `chatops_repo.enabled: true` plus a private
  admin repo correctly hides ChatOps surface from public repos.
- **Issue forms in `docs/temper-ops-template/`** dispatch to ChatOps via
  `handleChatopsIssue` based on `chatops:<command>` label. Smoke-tested.

## What's confirmed broken (the bugs.md file is the prioritized list)

Top categories from 13 specialists:

1. **Silent state mutation** — `synchronizeIssueLabels` deletes labels not in
   target list. **Destructive** on every webhook tick.
2. **Trust-boundary fail-open** — `WEBHOOK_SECRET` defaults to literal
   `"development"` in Probot when env var is unset. Index doesn't fail-fast.
3. **Unauthenticated dashboard POST routes** can trigger org-wide actions and
   exfiltrate repo data.
4. **`issues.opened` provisioning has no auth gate** (the comment-driven
   commands do; the issue-form path doesn't).
5. **`/health` lies** — always returns 200 even when scheduler is dead. PM2
   never restarts on hang.
6. **Silent degradation reported as success** — rulesets 422 → fallback to
   legacy → "✅ Configured". `setRequiredSignatures` 404 → swallowed → audit
   trail says "configured" but enforcement isn't there.
7. **Test mocks fake the broken namespace** — `createMockOctokit` retrofits
   `octokit.issues.X` over `octokit.request` so production code that uses
   `.issues.X` *passes tests* and *crashes in prod*. This is exactly the PR #22
   regression class, still active in 2 test files.
8. **Module-level singletons everywhere** — `_taskStore`, `_scheduler`,
   `_octokit`, `_reviews`, `activeLogger`, `config`. No injection seam.
9. **Inline AI review on `pull_request.opened`** is not in the task store; PM2
   restart mid-review = silent loss.
10. **No GitHub Check Run** — AI review can't be a required check, so its
    "request_changes" verdict cannot actually gate merges.

## What's been deliberately left for wave-2 (open questions)

- **Multi-lens AI review** — discover (3 narrow lenses) → fresh-session validate
  → emit. The single-shot strict-JSON path is wave-1; multi-lens is the next
  quality jump and was scoped but not built.
- **GitHub Check Runs API integration** — converting AI review verdicts into
  `check_run` results that can be required-checked. Architecture decision pending.
- **`pull_request.synchronize` event subscription** — bot doesn't re-review on
  force-push today. Probot expert flagged this as a 10-line change.
- **Replace `reviews.json` with a SQLite table** — DevOps + Performance both
  flagged the unbounded full-file-rewrite pattern.
- **Split `src/app.js`** — 1159 lines doing event handling, ChatOps slash
  commands, ChatOps issue-form dispatch, persistence init, scheduler init,
  helper utilities. Senior code reviewer's recommended next refactor.
- **CLI `temper-admin`** — single binary wrapping every diagnostic in the
  runbook. Day-2 ops agent's #1 missing tool.
- **Per-repo config overlay** — currently global only. Many fixes touch this
  surface; do it before adding policy variations.

## How to pick up a fix

1. Skim `docs/agent-fleet/bugs.md` — pick a bug.
2. Verify the file:line citation is still accurate (the codebase moves; some
   findings may have been fixed in PR #34+).
3. Branch off `main`. Open a focused PR. Don't bundle.
4. Tests: **don't trust** `__tests__/integration/{ai-review,app}.test.js` —
   their `createMockOctokit` retrofit fakes the broken namespace. If your fix
   touches an octokit call, add a "real-shape" test (only `.request()` and
   `.paginate()`, no `.issues`/`.repos` namespaces).
5. PR description should cite which wave-1 agent (or multiple) flagged the bug,
   and quote the file:line reference.

## Reference: the 14 wave-1 personas + their non-overlapping scopes

| # | Persona | Primary scope |
|---|---|---|
| 1 | Junior dev | README/DEVELOPMENT/SETUP onboarding experience |
| 2 | Safety-critical EE architect | Failure modes vs ASIL-D/safety-critical fitness |
| 3 | QA bug-hunter | Race conditions, error swallowing, off-by-one |
| 4 | Security auditor | OWASP top 10, signature, injection, traversal |
| 5 | DevOps / SRE | Production readiness, observability, recovery |
| 6 | Documentation reviewer | Docs vs code drift |
| 7 | Senior code reviewer | Module cohesion, complexity hotspots (pending) |
| 8 | Performance engineer | Hot paths, latency, parallelism |
| 9 | Day-2 operations | Runbook for 8 incident types |
| 10 | Probot/Octokit expert | v14 idioms, deprecated patterns, missing events |
| 11 | Supply-chain compliance | SBOM, provenance, deps, license, lockfiles |
| 12 | LLM prompt engineer | Strict-JSON contract, slop filter, multi-lens |
| 13 | Rivet integration | Oracle correctness, schema drift, missed features |
| 14 | Test quality | Coverage shape, mock leakage, flakiness |

Each agent's full report is in `/private/tmp/claude-501/.../tasks/<id>.output`
on the orchestrator's machine; the synthesis here is the canonical record.

## Cross-cutting themes (multiple agents converged)

- **"Looks like it ran" failure pattern** — repeated across the codebase:
  ruleset 422 → silent legacy fallback, signed-signatures 404 → silent skip,
  scheduler tick error → silent skip, save-review IO error → silent reset to
  `[]`. Fix by class, not case-by-case.
- **The bot can't actually gate commits** — it posts a comment, not a Check
  Run. Every "AI review enforces standards" framing in docs is hollow until
  this is wired.
- **Mocking too much** — `app.test.js` jest.mocks 12 modules. Most tests
  exercise routing logic against ghosts. Add at least one wired integration
  test per dispatch path.
- **Module-level state is the architectural debt** — every singleton blocks
  isolation, testing, and multi-installation. Untangling this is the
  highest-leverage refactor.
