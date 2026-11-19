# AI-review evaluation, pre-registration (2026-11-19, before any model run)

Owner decision 2026-11-19 (relayed by smithy): temper owns the AI-review
redesign and its evaluation. This file is fixed before the first candidate
or reference run; any later change is appended under "Amendments" with a
date and a reason, never edited in place.

## Question

Which local model can serve as temper's stage-3 reviewer (it reviews only
the hunks a stage-1 router passes on), on netcup (CPU, 3 GB cap) or on the
mini (M4, 16 GB shared), and does trimming the diff keep recall while
cutting latency? Where the reviewer runs is the owner's call after this.

## Data: 10 merged PRs, chosen by rule

Rule: incidents in pulseengine.eu docs/incidents/run.json with
`escape: true` and a `hotfix-ref` signal (a later PR says it fixes this
one), merged 2026-09-01..2026-11-15. At most 2 per repo, most recent
first. Excluded: dependency bumps, lockfile-only and rivet-artifact-only
chores, binary diffs, diffs over 2,000 changed lines. Mostly Rust, with
CI/shell/Ansible.

| PR | kind | fixed later by |
|---|---|---|
| meld#464 | Rust | meld#466 |
| spar#528 | Rust | spar#531 |
| spar#538 | Rust | spar#548 |
| rivet#899 | Rust | rivet#908 |
| ordeal#183 | Rust + SMT | ordeal#197 |
| gale#443 | Rust + CI | gale#445 |
| jess#228 | Rust + CI, 1,000 lines | jess#230 |
| loom#428 | CI workflow | loom#431 |
| jess#197 | shell + YAML | jess#202 |
| (private infra repo, 1 PR) | CI workflow + Python | (private) |

Each PR's diff, metadata and fixing PR are in prs/<repo>-<n>/.

## Two references

1. **Opus reference.** One fresh Opus agent per PR reviews the full diff.
   It may read the repository at the PR's merge commit. It does NOT see the
   fixing PR. Output per finding: file, new-side line, quoted_line, class,
   net_class, cwe (security only), severity, claim. Only findings anchored
   on a line the diff adds or changes count. Opus output is a scoring
   reference only, never training data for any model.
2. **Known defect.** Before any candidate run, the defect each fixing PR
   repaired is located in the escape PR's diff (file, new-side line, class)
   from the fixing PR's diff, in prs/<repo>-<n>/known.json. Where the defect
   is not on a line of the escape diff (e.g. an omission), it is recorded as
   `anchored: false` and scored only by file.

The owner spot-checks the Opus reference on 3 PRs: meld#464, the private-repo PR,
jess#228.

## Candidates and settings

- netcup tags, quality measured on the mini with identical Ollama tags:
  qwen2.5-coder:1.5b, granite4:3b-h, qwen3.5:2b, qwen2.5-coder:3b (the
  current production model; baseline only, non-commercial licence).
- mini only: qwen3:4b-instruct-2507, qwen2.5-coder:7b.
- Runtime: Ollama's OpenAI-compatible endpoint, temperature 0, seed 1,
  max_tokens 2000, response_format = temper's REVIEW_JSON_SCHEMA plus one
  required field `class` per finding (enum below). The system prompt is
  temper's STRICT_SYSTEM_PROMPT with one added rule naming the classes.
  Findings are kept or dropped by temper's own filterFindings.
- Timeout 600 s on the mini (to measure, not to cut off).
- Latency on the target: each netcup candidate on a fixed 3-PR subset
  (meld#464, loom#428, spar#538), full and trimmed, on netcup.

## Variants

- **full**: temper's production prompt, buildReviewPrompt with
  max_diff_size 12000, unchanged.
- **trimmed** (stage-1 stand-in until sieve delivers change info; fixed
  mechanical rules, no model):
  1. drop temper's tier-0 files (lockfiles, generated, vendored), `*.md`,
     `*.txt`, LICENSE, binary files, pure renames, and rivet artifact YAML
     under `artifacts/`;
  2. keep the rest hunk by hunk with one line of context;
  3. order: source, then workflows/Ansible/shell, then tests, then other;
     whole hunks only, budget 6,000 characters.

## Classes

logic, error-handling, security, concurrency, resource, api-contract,
test-gap, vacuous-check (a test or gate that cannot fail), config-ci,
docs-mismatch. The reference also records the incident ledger's net class
(no-test, vacuous-gate, skipped-or-non-required-check, merged-without-ci,
human-override, wrong-system, wrong-object, unclassified) and a CWE id for
security findings.

## Matching (the matcher implements exactly this)

- A finding's location is (file, line). A candidate's line is the new-side
  line of its quoted_line in that file's diff (whitespace-normalised, as
  temper's normaliseForQuote); if the quote occurs more than once, the
  occurrence nearest the stated line; if it does not occur, the stated line.
- **Primary match**: same file path, |line difference| <= 3, same class.
- **Secondary match**: same file, |line difference| <= 3, any class.
- One-to-one: pairs are taken greedily by smallest line difference; a
  reference finding is matched at most once.

## Metrics, each with its denominator

Per model x variant:
- recall = matched reference findings / all reference findings (primary
  and secondary);
- known-defect recall = known defects matched / anchored known defects
  (Opus is scored on this too);
- false findings per PR = candidate findings matched to nothing / 10;
- format failures = runs where tryParseReview fails / 10;
- dropped by filterFindings = count;
- latency median and p90 (mini for all; netcup for the subset).

## Bar, set now

A candidate is viable as the stage-3 reviewer on its machine if, on
**trimmed**: primary recall >= 0.25, false findings <= 1.5 per PR, format
failures <= 1 of 10, and p90 latency on the target machine <= 120 s.

Kill criterion: if no local candidate meets the bar, the report says that
a local model of this size is not a reviewer here. Review then rests on
the mechanical gates plus a reviewer the owner places elsewhere (mini-larger
or a hosted API), and the evaluation does not search for a passing subset
after the fact.

Determinism check: one PR (loom#428) run twice per model; any difference
is reported.

## Amendments

(none)
