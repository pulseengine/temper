# Development Guide

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | >= 20.11.0 | Required by `engines` in package.json |
| npm | Bundled with Node | Used for dependency management |
| pnpm | Latest | Required only if using Bazel (pnpm-lock.yaml) |
| Bazel (Bazelisk) | Latest | Optional; alternative build/test system |
| pre-commit | Latest | Optional; runs formatters and linters on commit |

## Quick Start

```bash
git clone <repo-url>
cd temper
npm install
```

Create a `.env` file (or export the variables) with your GitHub App credentials:

```bash
APP_ID=123456
PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
WEBHOOK_SECRET=your-webhook-secret
```

Legacy environment variable names (`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`) are also accepted and mapped automatically.

Start the server:

```bash
npm start          # production: node index.js
npm run dev        # development: nodemon with auto-reload
```

The app listens on `PORT` (default 3000) and exposes:

- `POST /api/github/webhooks` -- GitHub webhook receiver
- `GET /health` -- health check with queue stats
- `GET /webhook` -- lists subscribed event types

## Project Structure

```
temper/
  index.js              Entry point; re-exports public API, boots Probot via run()
  functions.js          Convenience re-exports for external consumers
  config.yml            Declarative repository configuration (merge, protection, labels, etc.)
  src/
    app.js              Probot event handlers, ChatOps command router, custom HTTP routes
    config.js           Loads and validates config.yml; provides merge/branch-protection settings
    schema.js           Validates config.yml structure (type checks, required fields)
    repository.js       Orchestrates full repository configuration (merge, protection, labels, templates, dependabot)
    branch-protection.js Applies branch protection rules and required-signatures toggle
    labels.js           Synchronizes issue labels (create, update, delete) to match config
    templates.js        Pushes PR/issue templates and CODEOWNERS into target repos
    dependabot.js       Applies dependabot.yml, checks existing config, fixes missing PR labels
    merge-strategy.js   Signed-commit merge override: temporarily enables merge commits, auto-reverts
    organization.js     Org membership checks, bulk repo sync, org-wide analysis report generation
    reporting.js        Generates per-repo configuration reports and CI attestation verification
    ai-review.js        AI-powered PR review via a local OpenAI-compatible endpoint
    github-api.js       Low-level helpers: upsert repo files, create configuration PRs
    helpers.js          Pure utilities: normalizeRepoInput, getDefaultBranch, isForkRepo
    logger.js           Pino-based structured logger with get/set/reset singleton pattern
    queue.js            In-process sequential job queue (avoids GitHub API rate limits)
    retry.js            Exponential backoff with jitter; retries only transient errors (5xx, 429)
    idempotency.js      In-memory webhook delivery deduplication with TTL-based auto-cleanup
    middleware.js       Helmet security middleware for Express router
    BUILD.bazel         Bazel js_library target for src/ modules
```

## Development Workflow

### Running Locally

```bash
npm run dev
```

This uses `nodemon` to restart the server on file changes. The app detects the environment (`HETZNER_ENVIRONMENT`, `NETCUP_ENVIRONMENT`, or generic) and logs accordingly.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `APP_ID` | Yes | GitHub App ID |
| `PRIVATE_KEY` | Yes | GitHub App private key (PEM) |
| `WEBHOOK_SECRET` | Yes | Webhook signature secret |
| `PORT` | No | Server port (default: 3000) |
| `WEBHOOK_PATH` | No | Webhook endpoint path (default: `/api/github/webhooks`) |
| `NODE_ENV` | No | `production` or `development` |
| `LOG_LEVEL` | No | Pino log level (default: `info`) |
| `ORGANIZATION` | No | Target GitHub org (overrides config.yml) |
| `HETZNER_ENVIRONMENT` | No | Enables Hetzner-specific logging |
| `NETCUP_ENVIRONMENT` | No | Enables Netcup-specific logging |

## Testing

### Running Tests

```bash
npm test                       # run all tests (unit + integration + smoke)
npm test -- --testPathPattern=unit       # unit tests only
npm test -- --testPathPattern=integration # integration tests only
npm test -- --testPathPattern=smoke      # smoke tests only
npm test -- --coverage         # with coverage report
```

### Coverage Thresholds

The project enforces minimum coverage in `jest.config.cjs`:

| Metric | Threshold |
|---|---|
| Lines | 80% |
| Functions | 80% |
| Branches | 70% |

### Test Structure

```
__tests__/
  unit/          Pure logic tests (config, helpers, schema, logger, queue, retry, idempotency, middleware)
  integration/   Tests with mocked Octokit (app, repository, branch-protection, labels, templates,
                 dependabot, merge-strategy, organization, reporting, ai-review, github-api)
  smoke/         Real-process tests (no mocks)
    imports.test.js   Verifies all modules load and export expected symbols
    server.test.js    Spawns `node index.js` as a subprocess, checks HTTP endpoints
  fixtures/      Test data (e.g. test-private-key.pem)
```

### Smoke Tests

Smoke tests use a **subprocess-based approach** for ESM compatibility. Because the project is `"type": "module"` and Probot has 52+ ESM-only transitive dependencies that cannot be transformed by babel-jest:

- `src/` modules are imported directly (babel-jest handles the transform).
- `index.js` and `functions.js` are verified by spawning a real `node` subprocess with `--input-type=module` and checking exit codes and stdout.
- `server.test.js` spawns `node index.js` with test credentials, waits for the server to accept connections, then exercises HTTP endpoints.

### Jest Configuration

The Jest config (`jest.config.cjs`) uses:

- **babel-jest** transform for `.js` files (handles ESM-to-CJS conversion)
- A custom resolver (`jest-resolver.cjs`) for module resolution
- `transformIgnorePatterns` that allow transforming `probot`, `@octokit`, and related ESM packages

## Code Style

### ESM Modules

The project uses native ES modules (`"type": "module"` in package.json). All source files use `import`/`export` syntax. Jest tests are also ESM but transformed by babel-jest for compatibility.

### Pre-commit Hooks

Install hooks with:

```bash
pre-commit install
```

The following hooks run on every commit (`.pre-commit-config.yaml`):

| Hook | Source | Description |
|---|---|---|
| trailing-whitespace | pre-commit-hooks | Removes trailing whitespace |
| end-of-file-fixer | pre-commit-hooks | Ensures files end with a newline |
| check-merge-conflict | pre-commit-hooks | Prevents committing merge conflict markers |
| check-yaml | pre-commit-hooks | Validates YAML syntax |
| check-json | pre-commit-hooks | Validates JSON syntax |
| check-toml | pre-commit-hooks | Validates TOML syntax |
| check-case-conflict | pre-commit-hooks | Detects filename case conflicts |
| check-added-large-files | pre-commit-hooks | Blocks large file additions |
| detect-private-key | pre-commit-hooks | Prevents committing private keys |
| prettier | mirrors-prettier | Formats `.js`, `.json`, `.md`, `.yml`, `.yaml` |
| eslint | local | Lints `.js`, `.mjs`, `.cjs` with `--max-warnings=0` |
| tests | local (manual stage) | Runs jest with `--bail` (opt-in, not automatic) |

### Linting

```bash
npm run lint    # eslint src/ index.js functions.js __tests__/
```

ESLint is configured with zero warnings tolerance (`--max-warnings=0`).

## Build System

### Bazel (Optional)

The project supports Bazel via `bzlmod` (MODULE.bazel). It uses `aspect_rules_js` with a pnpm lockfile and pins Node.js 20.18.0.

```bash
bazel build //...       # build all targets
bazel test //...        # run all Bazel test targets
```

Or via npm scripts:

```bash
npm run build           # bazel build //...
npm run bazel:test      # bazel test //...
```

Bazel configuration (`.bazelrc`):

```
common --enable_bzlmod
build --jobs=auto --verbose_failures
test --test_output=errors --test_verbose_timeout_warnings
```

Bazel targets:

- `//src:lib` -- `js_library` containing all `src/*.js` modules
- `//__tests__:test` -- test target (if defined in `__tests__/BUILD.bazel`)

### npm Scripts

| Script | Command | Description |
|---|---|---|
| `start` | `node index.js` | Start production server |
| `dev` | `nodemon index.js` | Start with auto-reload |
| `test` | `jest --config jest.config.cjs` | Run test suite |
| `lint` | `eslint src/ index.js functions.js __tests__/` | Lint source and tests |
| `build` | `bazel build //...` | Bazel build |
| `bazel:test` | `bazel test //...` | Bazel test |
| `docker:build` | `docker build -t temper .` | Build the multi-stage Alpine image |
| `setup` | `node scripts/setup.js` | Interactive bootstrap wizard (org, user, email) |

## Architecture

### Dependency Graph

```
index.js
  +-- src/app.js (event handlers, command router)
        +-- src/config.js (singleton config, loads config.yml)
        |     +-- src/schema.js (validation)
        |     +-- src/helpers.js (pure utilities)
        +-- src/logger.js (pino singleton)
        +-- src/repository.js (orchestrator)
        |     +-- src/config.js
        |     +-- src/branch-protection.js
        |     +-- src/templates.js --> src/github-api.js
        |     +-- src/labels.js
        |     +-- src/dependabot.js --> src/github-api.js
        +-- src/organization.js (bulk ops)
        +-- src/reporting.js (reports, CI attestation)
        +-- src/merge-strategy.js (signed commit handling)
        +-- src/ai-review.js (local AI PR review)
        +-- src/idempotency.js (webhook dedup)
        +-- src/queue.js (sequential job queue)
        +-- src/middleware.js (helmet)
```

### Key Patterns

**Singleton config** -- `src/config.js` loads `config.yml` once at module load time. The parsed config is accessed via `getConfig()`. Tests can override it with `_setConfigForTesting()`.

**Structured logging** -- `src/logger.js` wraps pino in a get/set/reset singleton. When Probot provides its own logger via `context.log`, it is swapped in with `setLogger()`. All modules use `getLogger()` for consistent structured output.

**Job queue** -- `src/queue.js` provides a sequential async job queue (`JobQueue` class). Jobs run one at a time to avoid GitHub API rate limiting. A singleton `defaultQueue` is used throughout the app. The `/health` endpoint exposes queue stats.

**Idempotency** -- `src/idempotency.js` stores webhook delivery IDs in an in-memory Map with 1-hour TTL. Auto-cleanup runs every 10 minutes. Duplicate deliveries are silently skipped.

**Retry with backoff** -- `src/retry.js` wraps async functions with exponential backoff and jitter. Only transient errors are retried (HTTP 5xx, 429, network errors). Client errors (4xx except 429) fail immediately. Default: 3 retries, 1s base delay, 30s max delay.

**PR-based config changes** -- When `change_strategy.use_pull_requests` is enabled in config.yml, file changes (e.g., dependabot.yml) are applied via a PR rather than direct commits.

**Fork-aware settings** -- Merge settings and branch protection rules have separate overrides for forked repositories, configured under `forks:` and `branch_protection.fork_overrides` in config.yml.

## ChatOps Commands

All commands are triggered by commenting on an issue or PR. The commenter must be an organization member.

| Command | Description |
|---|---|
| `/configure-repo` | Apply full repository configuration (merge settings, branch protection, labels, templates, dependabot) |
| `/sync-all-repos` | Synchronize configuration across all repositories in the organization |
| `/check-config` | Generate a configuration report for the current repository |
| `/check-dependabot` | Check Dependabot configuration and PR label compliance |
| `/fix-dependabot-labels` | Add missing labels to open Dependabot PRs |
| `/analyze-org` | Generate a full organization analysis report (creates a new issue) |
| `/check-merge-strategy` | Analyze a PR's merge strategy and signed commit status |
| `/allow-merge-commit` | Temporarily enable merge commits for signed-commit preservation (admin-only, auto-reverts after 1 hour) |
| `/review-pr` | Trigger an AI-powered code review (requires `ai_review.enabled: true` in config; PR only, not issues) |

## Configuration

The `config.yml` file controls all behavior. Top-level sections:

| Section | Purpose |
|---|---|
| `organization` | Target GitHub organization name |
| `settings.merge` | Default merge strategy (rebase-only by default) |
| `forks.merge` | Overridden merge settings for forked repos |
| `branch_protection.default` | Branch protection rules for the default branch |
| `branch_protection.fork_overrides` | Loosened protection for forks |
| `issue_labels` | Standard labels to synchronize across all repos |
| `pull_request_rules` | Required reviews, status checks, stale review dismissal |
| `signed_commit_strategy` | Merge commit override for signed commits (admin users, timeout, protected branches) |
| `ci_attestation` | Required CI checks and attestation format (sigstore) |
| `dependabot` | Dependabot v2 configuration to push to repos |
| `change_strategy` | Whether to apply changes via PR or direct commit; PR metadata |
| `templates` | Paths to PR/issue templates to push |
| `codeowners` | Path to CODEOWNERS file to push |
| `ai_review` | Local AI review endpoint, model, prompt, limits, rate limiting |

## Docker

Build and run:

```bash
docker build -t temper .
docker run -p 3000:3000 \
  -e APP_ID=123456 \
  -e PRIVATE_KEY="$(cat private-key.pem)" \
  -e WEBHOOK_SECRET=your-secret \
  temper
```

The Dockerfile uses a multi-stage build:

1. **Builder stage** -- `node:20-alpine`, runs `npm ci --production`
2. **Production stage** -- `node:20-alpine`, copies `node_modules`, app files, runs as non-root user (`appuser:1001`)

Features:
- Non-root execution (UID/GID 1001)
- Built-in healthcheck (`wget -qO- http://localhost:3000/health` every 30s)
- Exposes port 3000

## CI Pipeline

GitHub Actions (`.github/workflows/ci.yml`) runs on push/PR to `main`:

| Job | Description |
|---|---|
| `test` | `npm ci`, `npm test`, eslint, `npm audit` |
| `bazel-build` | `bazel build //...` |
| `bazel-test` | `bazel test //...` (depends on bazel-build) |
| `sbom` | Generates SPDX SBOM and attests it via Sigstore (main branch only) |
| `provenance` | Attests build provenance via Sigstore (main branch only) |
