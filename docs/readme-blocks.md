# Shared README blocks

Status: proposed. The decisions are tracked in the seam issue `temper-fleet/readme-blocks`. Nothing here is built yet.

The owner decided on 2026-11-27 that PulseEngine repos read as one platform through shared README blocks, which temper keeps in sync. This file is the contract between temper and each repo that opts in.

## Ownership

A README is hand-written in the readme-front-page shape: name and sentence, vision, why use it, quick start, status, where to find more. The repo's own session owns it. temper owns only the text between marker pairs that the repo placed itself. temper never adds, moves or removes a marker, and never changes text outside a pair.

## Blocks

| Block | Marker name | Contents |
|---|---|---|
| Header line | `header` | `# {{name}}` and `{{one_liner}}` |
| Badge row | `badges` | Licence and status badges, then `{{badges}}` |
| Part-of strip | `part-of` | "Part of PulseEngine", linking to the platform map |
| Contributing | `contributing` | One line inviting issues and pull requests |
| Licence | `licence` | `{{licence}}`, linking to `LICENSE` |
| Footer | `footer` | `Part of <a href="https://github.com/pulseengine">PulseEngine</a> &mdash; a WebAssembly Component Model engine for safety-critical systems{{footer_tail}}` |

## Markers

A repo adopts a block by placing its marker pair, each marker on a line of its own:

```markdown
<!-- pulseengine:footer -->
<!-- /pulseengine:footer -->
```

- A block without its markers is out of scope for that repo; it is not drift.
- An unknown block name, a duplicate pair, a nested pair, a closing marker before its opening one, or an unclosed marker makes the README unsyncable. temper reports why and writes nothing.

## Variables: `.github/pulseengine.yaml`

```yaml
format: 1
name: zwinger
one_liner: "zwinger confines an AI agent, whichever one you run, and every process it starts to what one typed profile allows."
status: active             # experimental | active | maintained | archived
licence: MIT               # SPDX id
docs:                      # optional, rendered in order
  - {title: "Profile reference", href: "docs/profile.md"}
badges: []                 # optional, extra badges after licence and status
footer_tail: ""            # optional, e.g. ", with machine-checked proofs for parts of it"
```

- The file is read with rivet-yaml from rivet tag v0.43.3 (e390eca). That parser reads YAML 1.2, so an unquoted `yes`, `no`, `on` or `off` is a string.
- The file is strict: an unknown key, a duplicate key, a missing required key (`format`, `name`, `one_liner`, `status`, `licence`) or an unknown `status` refuses it, and nothing is synced.
- A repo without the file is not in scope.

## Rendering

- `{{name}}` substitutes a variable. A variable that a block uses and the file does not define is an error, never an empty string.
- Values placed into HTML, such as the footer and the part-of strip, are HTML-escaped. Values placed into Markdown are inserted as written.
- Comparison is byte-exact after normalising line endings to LF. Drift means the text between a marker pair differs from the rendered block.

## Drift report

temper-report.v1 gets one rule, `readme.shared_blocks`, with one finding per repo whose notes name the drifted blocks. The codes are:

- `ok`
- `drift`
- `not_applicable` (no variables file, or no markers)
- `divergent_declared` (the repo declares a reason to keep a block different)

An unsyncable README or an unreadable variables file reports `drift` with the reason in the notes. warte rejects a report that carries an unknown value, so temper emits this rule only after warte accepts it.

## Sync pull requests

- At most one temper PR per repo, on branch `temper/readme-blocks`. An open one is updated in place.
- The commit is made through the GitHub API with temper's App token, so GitHub signs it. It changes `README.md` only, and only between markers.
- temper never arms auto-merge on these PRs. The repo's session merges once the required checks pass by name.
- Repos without a session get a drift report and no PR, until the owner decides otherwise.

## Rollout

1. The pilot repos are zwinger and kapsel; kapsel's starts after kapsel#141 merges.
2. temper ships behind `readme_blocks.enabled: false`, then turns on with `readme_blocks.repos: [zwinger, kapsel]`.
3. After two clean sync cycles on the pilot, other repos opt in. Each adds the variables file and markers in its own session.
