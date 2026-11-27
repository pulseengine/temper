# Shared README blocks

Status: decided (pulseengine/temper#128, seam `temper-fleet/readme-blocks`). The module and templates are built. temper does not load the module yet, and the feature is off.

The owner decided on 2026-11-27 that PulseEngine repos read as one platform through shared README blocks, which temper keeps in sync. This file is the contract between temper and each repo that opts in.

## Ownership

A README is hand-written in the readme-front-page shape: name and sentence, vision, why use it, quick start, status, where to find more. The repo's own session owns it. temper owns only the text between marker pairs that the repo placed itself. temper never adds, moves or removes a marker, and never changes text outside a pair.

## Blocks

The templates live in `templates/readme/<block>.md`. A wording change passes temper's required checks and merge queue, and reaches repos only through smithy's pinned deploys.

| Block | Marker name | Contents |
|---|---|---|
| Header line | `header` | `# {{name}}`, a blank line, `{{one_liner}}` |
| Badge row | `badges` | Status and licence badges (shields.io), then `{{badges}}` |
| Part-of strip | `part-of` | "`{{name}}` is part of PulseEngine", linking to https://pulseengine.eu/how-it-works/ |
| Licence | `licence` | `{{licence}}. Issues and pull requests are welcome.` |
| Footer | `footer` | The centred `<sub>` line: `Part of <a href="https://github.com/pulseengine">PulseEngine</a> &mdash; a WebAssembly Component Model engine for safety-critical systems{{footer_tail}}` |

The licence block carries the contributing invitation, so there is no separate contributing block. Its text matches zwinger's hand-written line, so zwinger can adopt it without a diff.

## Markers

A repo adopts a block by placing its marker pair, each marker on a line of its own, with nothing else on the line:

```markdown
<!-- pulseengine:footer -->
<!-- /pulseengine:footer -->
```

- A block without its markers is out of scope for that repo; it is not drift.
- Markers inside fenced code blocks are ignored.
- An unknown block name, a malformed marker, a duplicate pair, a nested pair, a closing marker before its opening one, or an unclosed marker makes the README unsyncable. temper reports why and writes nothing.

## Variables: `.github/pulseengine.yaml`

```yaml
format: 1
name: zwinger
one_liner: "zwinger confines an AI agent, whichever one you run, and every process it starts to what one typed profile allows."
status: active             # experimental | active | maintained | archived
licence: MIT               # SPDX expression
badges: []                 # optional: {alt, image, href} entries after status and licence
footer_tail: ""            # optional, e.g. ", with machine-checked proofs for parts of it"
```

- The file is read with rivet-yaml from rivet tag v0.43.3 (e390eca). That parser reads YAML 1.2, so an unquoted `yes`, `no`, `on` or `off` is a string.
- The file is strict: an unknown key, a duplicate key, a missing required key (`format`, `name`, `one_liner`, `status`, `licence`), an unknown `status` or a `format` other than 1 refuses it, and nothing is synced.
- Values are single lines and may not contain `<!--` or `-->`. A badge's `image` and `href` are https URLs without spaces, brackets or quotes.
- A repo without the file is not in scope.

## Rendering

- `{{var}}` inserts a value as written, `{{var|html}}` HTML-escaped, and `{{var|shield}}` as a shields.io badge path segment. Templates use `|html` wherever a value lands inside HTML, such as `footer_tail` in the footer.
- An unknown variable or filter in a template is temper's fault: the check fails and reports nothing for that repo, rather than rendering an empty string.
- Comparison is line-exact after normalising CRLF to LF. A synced README keeps CRLF line endings if it had any.

## Drift report

temper-report.v1 gets one check, `readme.shared_blocks`, per repo, severity low. It carries only the code, with no notes and no block names (agreed with warte, 2026-11-27):

- `ok`: every marked block matches its template.
- `not_applicable`: no variables file, or no markers.
- `divergent_undeclared`: a marked block differs from its template, the README is unsyncable, or the variables file is refused.
- `divergent_declared`: reserved. temper does not emit it yet, because a repo that wants a block different removes its markers.

warte v1.6.53 is the first release that accepts the check. temper emits it only once the hub runs 1.6.53 or later.

## The module

`tools/readme-blocks` is a Rust program that temper runs as a WASI module (`wasm32-wasip1`) with `node:wasi`. The same source also builds as a `wasm32-wasip2` command component (owner, 2026-11-27: run what we build). CI runs it under wasmtime v50.0.1 in the required `triage` job. kiln runs fused components only, so it joins as an advisory runner (`meld fuse --reproducible`, then kiln 0.9.0) once the covalent layer carries kiln 0.9.0 and meld 0.70.0.

```sh
readme-blocks check --variables <file> --readme <file> --templates <dir> --format json
readme-blocks interface-version      # prints 1
```

- `check --format json` prints `{"interface":1,"code":…,"reason":…,"blocks":[{"name":…,"state":"ok"|"drift"}],"readme":…}`. `readme` is the synced README, present only when a block drifted and the README is syncable. `reason` is for temper's log and never reaches the report.
- Exit codes: 0 when a report was printed, 1 when the check could not run (an unreadable file or a broken template), and 2 for a usage error. They hold under both targets: `main` ends in `std::process::exit`, which a Rust 1.100 wasip2 build passes through `exit-with-code`.

## Delivery (agreed with smithy, 2026-11-27)

- Releases use their own tag namespace, `readme-blocks-vX.Y.Z`, built by `.github/workflows/readme-blocks-release.yml` on that tag. The tag must name the version in `tools/readme-blocks/Cargo.toml`. Each release carries `readme-blocks-vX.Y.Z-wasm32-wasip1.wasm`, `readme-blocks-vX.Y.Z-wasm32-wasip2.wasm`, a CycloneDX SBOM, `build-env.txt`, `SHA256SUMS.txt`, a cosign keyless bundle over the sums, and a GitHub build attestation.
- smithy verifies all three, pins the version and sha256, and installs the module read-only per version. smithy pins and deploys only the wasip1 file. The wasip2 file gets its own pin and PR once a kiln that runs it exists and the owner asks for it.
- temper's config holds the module path and its sha256. temper refuses to load a module whose sha256 differs, or whose `interface-version` is not the one it accepts, and logs which.
- The first tag is the owner's decision.

## Sync pull requests

- At most one temper PR per repo, on branch `temper/readme-blocks`. An open one is updated in place.
- The commit is made through the GitHub API with temper's App token, so GitHub signs it. It changes `README.md` only, and only between markers.
- temper never arms auto-merge on these PRs. The repo's session merges once the required checks pass by name.
- Repos without a session get a drift report and no PR, until the owner decides otherwise.

## Rollout

1. The pilot repos are zwinger and kapsel. kapsel starts after kapsel#141 merges.
2. temper ships behind `readme_blocks.enabled: false`. smithy flips it in a separate PR, with `readme_blocks.repos: [zwinger, kapsel]`, after the module is deployed and verified.
3. After two clean sync cycles on the pilot, other repos opt in. Each adds the variables file and markers in its own session.
