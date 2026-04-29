# temper-ops setup

The **temper-ops** repo is the private command-and-control surface for Temper.
It's where you trigger sweeps, request reviews, and invoke ChatOps without
leaving a footprint on public repos.

## Why a separate (private) repo

Temper's slash commands (`/sync-all-repos`, `/configure-repo`, `/review-pr`,
etc.) are honoured wherever the bot is installed and the commenter is in
`allowed_command_users`. By default, that means a maintainer commenting
`/sync-all-repos` in *any* public repo lands the bot's "Working on it…"
reply, the result, and any error trace in that public repo's issue thread.

Setting `chatops_repo.enabled: true` in `config.local.yml` constrains the
trigger surface to a single repo. Combined with making that repo private,
the conversation between you and the bot stays out of public view —
while bot-initiated configuration PRs against public repos continue to be
public, as they should be.

## One-time setup

### 1. Create the repo

```bash
gh repo create pulseengine/temper-ops --private --description "Temper bot ChatOps surface"
```

(or via the GitHub UI — anything works, as long as it's private.)

### 2. Install the Temper App on the new repo

In the Temper GitHub App settings, add `pulseengine/temper-ops` to the
list of repositories it can access. The bot needs the same permissions
it has on every other repo (Contents, Issues, PRs, Members read).

### 3. Wire the bot to the new repo

On the deployment host (`/opt/temper/config.local.yml`):

```yaml
chatops_repo:
  enabled: true
  repo: pulseengine/temper-ops
```

Then `pm2 restart temper`. From this point onwards, slash commands posted
in any *other* repo are silently dropped.

### 4. Copy the issue forms

The bundled templates under `docs/temper-ops-template/` give you forms for
the four most common operations:

```bash
git clone git@github.com:pulseengine/temper-ops.git
cd temper-ops
mkdir -p .github/ISSUE_TEMPLATE
cp -r ../temper/docs/temper-ops-template/.github/ISSUE_TEMPLATE/*.yml \
      .github/ISSUE_TEMPLATE/
git add .github && git commit -m "chore: add Temper ChatOps issue forms" && git push
```

After that, opening a new issue in temper-ops shows a chooser with the
forms. Submit one and the bot does the rest.

## Forms shipped

| Form | What it does | Bot behaviour |
|---|---|---|
| **Sync all repos** | Re-runs the full org configuration sweep | bot replies with progress, then result, then closes the issue |
| **Configure single repo** | Re-applies standard config to one repo | requires `Repository` field; bot configures and replies |
| **Org analysis report** | Generates an org-wide configuration report | bot creates a separate report issue and links it |
| **Review pull request** | Triggers AI review on a specific PR | requires `Repository` and `PR number`; bot posts the review on the target PR, replies on the temper-ops issue with the link |

Each form's first label is `chatops:<command>` — that's what the bot uses
to dispatch.

## Operating notes

- **Issues stay as the audit trail.** The bot replies on the source issue
  and closes it on success. The closed issue with the form fields is the
  record of what was triggered, by whom, when, and what the bot did.
- **Slash commands still work** as comments inside temper-ops, alongside
  the issue forms. The two paths are equivalent — pick whichever feels
  natural.
- **`/review-pr` is also still available** on the target PR itself for
  one-off in-context use; the form is just the no-leave-this-repo path.
- **Bot replies are private** because they're in temper-ops. Bot's actual
  configuration PRs against public repos stay public.

## Adding more forms

To wire a new ChatOps command into the form workflow:

1. Add `<command>.yml` under `docs/temper-ops-template/.github/ISSUE_TEMPLATE/`
   with `labels: ["chatops:<your-command>"]`.
2. Add a case for `chatops:<your-command>` in `handleChatopsIssue` in
   `src/app.js`.
3. The form's body fields are accessible via `parseIssueFormBody(issue.body)`
   — see the existing handler for reference.
4. Copy the new template into the actual temper-ops repo.

Forms are *only* read in the temper-ops repo (or whatever you configure
`chatops_repo.repo` to be). They have no effect in other repos.
