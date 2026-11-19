# review-bench: the gate for any model reviewer in temper

temper's local-model PR review is off (`ai_review.enabled: false`, owner decision 2026-11-19, temper#92): no local model of 1.5–8B parameters met the pre-registered bar. **A review model is switched on only after it clears the same bar on this set**, scored by `revmatch`, with the run written up on temper#92 or a successor issue.

## The bar (from PREREG.md, fixed before the first run)

On the **trimmed** variant: primary recall >= 0.25, false findings <= 1.5 per PR, format failures <= 1 per 10 PRs, p90 latency <= 120 s on the machine it will run on.

- **Primary match:** same file, line within ±3 (the line is resolved through the finding's quoted line), same class.
- **Secondary match:** the same without the class.

The full set has 10 PRs and 40 reference findings, so 10 of 40 is the recall bar. One PR is from a private repository and is kept only on the evaluation host. This public copy has 9 PRs and 33 reference findings; apply the bar as a ratio (9 of 33 rounds up to 0.27, so it is the stricter count) and run the full set before switching anything on.

## What is here

| path | what |
|---|---|
| `PREREG.md` | the pre-registration (public copy; amendments 1–3 are comments on temper#92) |
| `prs/<repo>-<n>/diff.patch`, `meta.json` | the merged PR as GitHub served it |
| `prs/<repo>-<n>/reference.json` | Opus reference findings: file, new-side line, quoted line, class, incident-ledger net class, CWE, severity, claim. A scoring reference, never training data |
| `prs/<repo>-<n>/known.json` | the defect the later fixing PR repaired, located in this diff (6 anchored in the full set, 5 here) |
| `run.mjs` | the runner: temper's own `buildReviewPrompt` → `callLocalAI` → `tryParseReview` → `filterFindings`, against any OpenAI-compatible endpoint |
| `revmatch/` | the matcher (Rust): `validate` and `score`, with `--explain` to print matched claims side by side |

## Run a candidate

```sh
# an Ollama (or other OpenAI-compatible) endpoint with a context of at least 8192 tokens:
# temper's full prompt is up to ~5.2k tokens plus 2k for the answer, and a smaller
# context silently cuts the system prompt (temper#92, amendment 2)
cd eval/review-bench
ENDPOINT=http://127.0.0.1:11434/v1/chat/completions node run.mjs <model> trimmed
ENDPOINT=http://127.0.0.1:11434/v1/chat/completions node run.mjs <model> full
cargo run --release --manifest-path revmatch/Cargo.toml -- score --prs prs --run runs/<model>/trimmed
cargo run --release --manifest-path revmatch/Cargo.toml -- score --prs prs --run runs/<model>/trimmed --explain
```

Read every matched pair (`--explain`) before reporting. The matcher scores location and class, not truth. In the 2026-11-19 run, most location matches were claims that described or praised the line rather than stating its defect.

## Result of 2026-11-19

8 models × 2 variants × 10 PRs, temperature 0, deterministic, nothing truncated at an 8k context. The best primary recall was 1 of 40 (ministral-3:8b, trimmed). Of all matched pairs, only 2 stated the same defect as the reference. For scale, the Opus reference itself locates 3 of the 6 known defects (any class), 1 of them in the same class. Full table: temper#92.
