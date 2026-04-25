# Controller repo template

This directory is a starter for the PulseEngine **controller repo** — a separate
repository whose only job is to host issue forms that drive new-repo creation
through Temper.

Recommended path: create a repo `pulseengine/repo-requests`, copy the contents
of this directory into its root, and configure Temper:

```yaml
# config.yml on the Temper deployment
controller_repo:
  enabled: true
  repo: pulseengine/repo-requests
  label: repo-request
  approval_reaction: "+1"
```

## How it works

1. A user files an issue in the controller repo using the **New repository
   request** form.
2. Temper's `issues.opened` handler picks up the issue (filtered by
   `config.controller_repo.repo` and the `repo-request` label), parses the form
   body, validates it, and enqueues a `provision-repo` task in the persistent
   task store.
3. The scheduler claims the task, creates the new repo (template-based when
   requested), applies the full org configuration (rulesets, merge settings,
   labels, templates, codeowners, dependabot), and comments the new repo URL on
   the source issue.
4. The source issue is closed with `state_reason: completed`. The new repo gets
   a `provisioned-from` custom property pointing back to the source issue —
   that's your audit trail.

## What you (the operator) need to fill in

Open `.github/ISSUE_TEMPLATE/new-repo.yml`. The bottom section has fields
marked `TODO` — they are the **5–10 lines that shape the feature for your org**:

- Which licenses are pre-approved (replace the dropdown list).
- Which custom properties matter (compliance tier, owning team, classification).
- Whether a CODEOWNERS team default makes sense (e.g. `@pulseengine/maintainers`).
- Any topics that MUST appear on every new repo (e.g. `pulseengine`).

These fields are the contract between humans and the bot — they're the part
where your domain knowledge improves the bot more than any code change could.
