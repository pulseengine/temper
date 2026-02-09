# Probot Repository Configurator

[![CI](https://github.com/avrabe/probot-repo-configurator/actions/workflows/ci.yml/badge.svg)](https://github.com/avrabe/probot-repo-configurator/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/node-%3E%3D20.11.0-brightgreen)

A Probot v14 GitHub App that automatically configures repositories to match
organization standards. It enforces merge settings, branch protection rules,
issue labels, PR/issue templates, CODEOWNERS, Dependabot configuration,
signed-commit merge strategies, and AI-powered PR reviews -- across every
repository in your GitHub organization.

## Features

- **Auto-configure new repositories** -- applies full configuration on `repository.created` events
- **Branch protection** -- enforces required reviews, status checks, signed commits, and linear history
- **Issue labels** -- synchronizes a standard label set (create, update, delete) across all repos
- **PR and issue templates** -- pushes PR templates, issue templates, and CODEOWNERS into target repos
- **Dependabot configuration** -- applies `dependabot.yml` and fixes missing PR labels
- **Signed-commit merge strategy** -- temporarily enables merge commits to preserve GPG signatures, then auto-reverts
- **AI-powered PR review** -- sends diffs to a local OpenAI-compatible endpoint for automated code review
- **Organization-wide sync** -- bulk-apply configuration to every repo in the org
- **ChatOps commands** -- 9 slash commands for on-demand configuration and diagnostics
- **Fork-aware settings** -- separate merge and branch-protection overrides for forked repositories
- **PR-based changes** -- optionally applies file changes via pull requests instead of direct commits
- **Idempotent webhook processing** -- deduplicates delivery IDs to prevent duplicate work
- **Retry with backoff** -- exponential backoff with jitter for transient GitHub API errors

## Quick Start

1. **Register a GitHub App** at `https://github.com/settings/apps/new` with
   repository (Contents, Issues, Pull Requests, Metadata) and organization
   (Members, Metadata) permissions. Subscribe to `repository`, `issue_comment`,
   and `pull_request` events.

2. **Clone and install:**

   ```bash
   git clone https://github.com/avrabe/probot-repo-configurator.git
   cd probot-repo-configurator
   npm install
   ```

3. **Configure environment variables** -- create a `.env` file:

   ```bash
   APP_ID=123456
   PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
   WEBHOOK_SECRET=your-webhook-secret
   ```

4. **Run:**

   ```bash
   npm start        # production
   npm run dev      # development (auto-reload via nodemon)
   ```

   The server listens on port 3000 (configurable via `PORT`) and exposes
   `POST /api/github/webhooks`, `GET /health`, and `GET /webhook`.

## ChatOps Commands

Comment on any issue or pull request to trigger a command. The commenter must
be an organization member.

| Command | Description |
|---|---|
| `/configure-repo` | Apply full repository configuration (merge settings, branch protection, labels, templates, Dependabot) |
| `/sync-all-repos` | Synchronize configuration across all repositories in the organization |
| `/check-config` | Generate a configuration report for the current repository |
| `/check-dependabot` | Check Dependabot configuration and PR label compliance |
| `/fix-dependabot-labels` | Add missing labels to open Dependabot PRs |
| `/analyze-org` | Generate a full organization analysis report (creates a new issue) |
| `/check-merge-strategy` | Analyze a PR's merge strategy and signed-commit status |
| `/allow-merge-commit` | Temporarily enable merge commits for signed-commit preservation (admin-only, auto-reverts after timeout) |
| `/review-pr` | Trigger an AI-powered code review (requires `ai_review.enabled: true`; PR only) |

## Configuration

All behavior is controlled by [`config.yml`](config.yml). Key sections:

| Section | Purpose |
|---|---|
| `organization` | Target GitHub organization |
| `settings.merge` | Default merge strategy (rebase-only by default) |
| `forks.merge` | Overridden merge settings for forked repos |
| `branch_protection` | Branch protection rules and fork overrides |
| `issue_labels` | Standard labels to synchronize |
| `pull_request_rules` | Required reviews, status checks |
| `signed_commit_strategy` | Merge-commit override for signed commits |
| `dependabot` | Dependabot v2 configuration to push to repos |
| `change_strategy` | PR-based vs. direct-commit change application |
| `templates` / `codeowners` | PR/issue templates and CODEOWNERS paths |
| `ai_review` | AI review endpoint, model, prompt, and limits |

See the file itself for the full schema and defaults.

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for the full development guide, including:

- Project structure and architecture
- Environment variables reference
- Testing (unit, integration, smoke) and coverage thresholds
- Pre-commit hooks and linting
- Bazel build system (optional)
- Docker usage
- CI pipeline details

## Deployment

The app can be deployed in several ways:

- **Docker** -- `npm run deploy:docker` builds and pushes a multi-stage Alpine image (runs as non-root, built-in healthcheck).
- **Heroku** -- `npm run deploy:heroku` pushes to Heroku via git.
- **PM2** -- `npm run deploy:server` starts or restarts the app under PM2 process management.
- **Netcup** -- `npm run deploy:netcup` installs production dependencies for shared hosting.

Set `APP_ID`, `PRIVATE_KEY`, and `WEBHOOK_SECRET` as environment variables in
your deployment target.

## License

[MIT](LICENSE)
