# temper-ops template

Starter content for the Temper ChatOps admin repo. Copy `.github/` from
this directory into your `pulseengine/temper-ops` (or whatever
`chatops_repo.repo` is configured to in `config.local.yml`).

```bash
cp -r .github/ISSUE_TEMPLATE/*.yml /path/to/temper-ops/.github/ISSUE_TEMPLATE/
```

After commit + push, opening a new issue in temper-ops will show the
chooser with all the forms. The Temper bot recognises any issue whose
first label starts with `chatops:` and dispatches the corresponding
command.

See `../temper-ops-setup.md` for the full setup walkthrough.
