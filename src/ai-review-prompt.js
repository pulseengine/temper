/**
 * Hardened AI review prompt + parser.
 *
 * Small local models (qwen2.5-coder:3b on this deployment) love escape
 * hatches: hedging, refusal, filler. The previous freeform prompt produced
 * exactly that — see PR #23's review comment for the textbook example.
 *
 * This module locks the model into a strict JSON contract and enforces the
 * contract with a deterministic parser + postprocessor:
 *
 *   1. System prompt forbids hedging, refusal, filler. Demands JSON only.
 *   2. tryParseReview() rejects malformed output. No retry: silence is fine.
 *   3. filterFindings() drops anything that hedges OR fails quote-or-die.
 *   4. computeVerdict() ignores the model's verdict; computes from findings.
 *
 * Rule of thumb: every finding that survives this pipeline must be
 * (a) anchored to a verbatim line in the diff, (b) phrased as a concrete
 * claim, (c) post-checked by a parser that can't be talked out of saying no.
 */

export const STRICT_SYSTEM_PROMPT = `You are reviewing a pull request. Output STRICT JSON only.

Rules:
1. Output MUST be valid JSON matching the schema below. NO prose before or after. NO markdown fences. The parser DISCARDS any extra text.
2. "verdict" MUST be one of: "approve", "comment", "request_changes". NO other values.
3. "findings" MUST be an array. Use [] if empty. NEVER null. NEVER omit the field.
4. Each finding's "quoted_line" MUST be copied VERBATIM from the diff (after the +/- marker, exactly as shown). Paraphrases are REJECTED.
5. Each finding's "claim" MUST be a direct declarative sentence. FORBIDDEN words in claims: "might", "could", "may", "possibly", "perhaps", "consider", "should", "generally", "typically".
6. FORBIDDEN phrases in claims (these add no value): "ensure proper error handling", "consider edge cases", "implement secure practices", "more context", "developer should", "in general", "improve robustness", "enhance validation".
7. If you have nothing concrete to flag, return "findings": []. DO NOT pad. DO NOT explain.
8. NEVER refuse. NEVER say "I cannot determine" or "insufficient information". If unsure, return "findings": [].

Schema:
{
  "verdict": "approve" | "comment" | "request_changes",
  "summary": "<1-2 sentences describing what the diff does, max 200 chars>",
  "findings": [
    {
      "file": "<path/to/file from the diff>",
      "line": <integer line number>,
      "quoted_line": "<verbatim line copied from the diff>",
      "claim": "<concrete falsifiable assertion, max 200 chars>"
    }
  ]
}

Example with a finding:
{"verdict":"comment","summary":"Adds status preservation in wrap_full_page middleware.","findings":[{"file":"rivet-cli/src/serve/mod.rs","line":1041,"quoted_line":"        *wrapped.status_mut() = status;","claim":"No new test asserts that a 4xx status survives wrap_full_page; serve_integration tests check 200 paths only."}]}

Example with no findings:
{"verdict":"approve","summary":"Pure docs change in README.","findings":[]}`;

const HEDGE_OR_SLOP_PATTERNS = [
  /\bmight\b/i,
  /\bcould\b/i,
  /\bmay\b/i,
  /\bpossibly\b/i,
  /\bperhaps\b/i,
  /\bgenerally\b/i,
  /\btypically\b/i,
  /\bconsider\s+/i,
  /\bshould\s+/i,
  /developer should/i,
  /ensure proper error handling/i,
  /consider edge cases/i,
  /implement secure practices/i,
  /(more|additional)\s+context/i,
  /(unable|insufficient)\s+(to|context)/i,
  /improve (robustness|validation)/i,
  /enhance (the )?(schema|validation)/i,
  /review and refactor/i,
  /in (most )?cases/i,
  /in general/i
];

export function isSlop(text) {
  if (typeof text !== 'string') return true;
  return HEDGE_OR_SLOP_PATTERNS.some((re) => re.test(text));
}

const ALLOWED_VERDICTS = new Set(['approve', 'comment', 'request_changes']);

/**
 * Parse the model's raw text into a structured review.
 * Forgiving on incidental wrapping (markdown fences, leading/trailing prose);
 * strict on shape (required fields, types, enum verdict).
 *
 * @returns {{ok: true, data: object} | {ok: false, error: string}}
 */
export function tryParseReview(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { ok: false, error: 'empty response' };
  }

  const candidate = rawText.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '');

  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const match = candidate.match(/\{[\s\S]*\}/);
    if (!match) return { ok: false, error: 'no JSON object in response' };
    try {
      parsed = JSON.parse(match[0]);
    } catch (e) {
      return { ok: false, error: `JSON parse failed: ${e.message}` };
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'not a JSON object' };
  }
  if (!ALLOWED_VERDICTS.has(parsed.verdict)) {
    return { ok: false, error: `invalid verdict: ${JSON.stringify(parsed.verdict)}` };
  }
  if (typeof parsed.summary !== 'string') {
    return { ok: false, error: 'summary must be a string' };
  }
  if (!Array.isArray(parsed.findings)) {
    return { ok: false, error: 'findings must be an array (use [] when empty)' };
  }
  for (const f of parsed.findings) {
    if (
      f === null ||
      typeof f !== 'object' ||
      typeof f.file !== 'string' ||
      typeof f.line !== 'number' ||
      typeof f.quoted_line !== 'string' ||
      typeof f.claim !== 'string'
    ) {
      return { ok: false, error: 'finding has missing or wrong-type fields' };
    }
  }
  return { ok: true, data: parsed };
}

/**
 * Drop findings whose claim hedges/slops, or whose quoted_line doesn't appear
 * verbatim in the diff (the quote-or-die rule).
 */
export function filterFindings(findings, diffText) {
  if (!Array.isArray(findings)) return [];
  return findings.filter((f) => {
    if (isSlop(f.claim)) return false;
    if (typeof diffText === 'string' && diffText.length > 0) {
      const needle = f.quoted_line.trim();
      if (needle && !diffText.includes(needle)) return false;
    }
    return true;
  });
}

/**
 * Compute the verdict deterministically from validated findings.
 * The model's `verdict` is advisory; this function decides.
 *
 * Promotion rules:
 *   - any oracle finding with severity 'error' → request_changes
 *     (these are evidence-grade: broken cross-refs, schema violations,
 *     missing required fields — the oracle has already said no)
 *   - otherwise any finding → comment
 *   - no findings → approve
 */
export function computeVerdict(findings) {
  if (!Array.isArray(findings) || findings.length === 0) return 'approve';
  if (findings.some((f) => f && f.severity === 'error' && typeof f.source === 'string' && f.source.startsWith('oracle:'))) {
    return 'request_changes';
  }
  return 'comment';
}

/**
 * Render the parsed + filtered review as a Markdown comment.
 * Returns null when the review should not be posted at all (no findings,
 * verdict approve) — silence is preferable to slop.
 */
export function renderReviewMarkdown(parsed, prNumber, headSha, meta, opts = {}) {
  const { skipApproveEmpty = true } = opts;
  const findings = parsed.findings || [];
  const verdict = computeVerdict(findings);

  if (skipApproveEmpty && verdict === 'approve' && findings.length === 0) {
    return null;
  }

  const verdictBadge = {
    approve: '✅ Approve',
    comment: '💬 Comment',
    request_changes: '🔴 Request changes'
  }[verdict];

  const lines = [];
  lines.push(`## AI Code Review for PR #${prNumber}`);
  if (meta?.headRepo && meta?.baseBranch && meta?.headBranch && meta?.baseRepo) {
    lines.push(`${meta.headRepo}:\`${meta.headBranch}\` → ${meta.baseRepo}:\`${meta.baseBranch}\``);
  }
  lines.push('');
  lines.push(`**Verdict:** ${verdictBadge}`);
  lines.push('');
  lines.push(`**Summary:** ${parsed.summary || '(none)'}`);
  lines.push('');

  if (findings.length === 0) {
    lines.push('**Findings:** None.');
  } else {
    lines.push(`**Findings (${findings.length}):**`);
    lines.push('');
    findings.forEach((f, i) => {
      if (typeof f.source === 'string' && f.source.startsWith('oracle:')) {
        // Oracle finding: artifact-anchored, mechanically validated.
        const sevBadge =
          f.severity === 'error' ? '🔴'
          : f.severity === 'warning' ? '🟡'
          : 'ℹ️';
        const oracleName = f.source.replace('oracle:', '');
        lines.push(`${i + 1}. ${sevBadge} \`${f.artifact_id || '<unknown>'}\` _(${oracleName})_`);
        lines.push(`   ${f.claim}`);
      } else {
        // Model finding: file:line-anchored, post-validated.
        lines.push(`${i + 1}. \`${f.file}:${f.line}\``);
        lines.push('   ```');
        lines.push(`   ${f.quoted_line}`);
        lines.push('   ```');
        lines.push(`   ${f.claim}`);
      }
      lines.push('');
    });
  }

  lines.push('---');
  lines.push(
    '*Generated by a local AI model and post-validated against a strict JSON contract. ' +
    'Each finding includes the verbatim line being criticised — verify by reading the file at the cited location.*'
  );
  if (headSha) {
    lines.push('');
    lines.push(`*Reviewed at \`${headSha.substring(0, 7)}\`*`);
  }

  return lines.join('\n');
}
