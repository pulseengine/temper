import {
  STRICT_SYSTEM_PROMPT,
  REVIEW_JSON_SCHEMA,
  buildResponseFormat,
  isSlop,
  tryParseReview,
  filterFindings,
  computeVerdict,
  renderReviewMarkdown
} from '../../src/ai-review-prompt.js';

describe('STRICT_SYSTEM_PROMPT', () => {
  it('includes the banned-word rule and example outputs', () => {
    expect(STRICT_SYSTEM_PROMPT).toMatch(/FORBIDDEN words/);
    expect(STRICT_SYSTEM_PROMPT).toMatch(/"verdict"\s*:\s*"approve"/);
    expect(STRICT_SYSTEM_PROMPT).toMatch(/quoted_line/);
    expect(STRICT_SYSTEM_PROMPT).toMatch(/NEVER refuse/);
  });
});

describe('REVIEW_JSON_SCHEMA', () => {
  it('declares the verdict enum exactly matching the parser', () => {
    expect(REVIEW_JSON_SCHEMA.properties.verdict.enum).toEqual([
      'approve', 'comment', 'request_changes'
    ]);
  });

  it('marks verdict, summary, findings as required', () => {
    expect(REVIEW_JSON_SCHEMA.required.sort()).toEqual(
      ['findings', 'summary', 'verdict']
    );
  });

  it('rejects extra properties (additionalProperties: false)', () => {
    expect(REVIEW_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(REVIEW_JSON_SCHEMA.properties.findings.items.additionalProperties).toBe(false);
  });

  it('every finding field used by the parser is declared in the schema', () => {
    const fields = Object.keys(REVIEW_JSON_SCHEMA.properties.findings.items.properties).sort();
    expect(fields).toEqual(['claim', 'file', 'line', 'quoted_line']);
  });
});

describe('buildResponseFormat', () => {
  it('returns OpenAI-compat json_schema payload', () => {
    const rf = buildResponseFormat();
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema.name).toBe('PullRequestReview');
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema).toBe(REVIEW_JSON_SCHEMA);
  });
});

describe('isSlop', () => {
  it.each([
    'consider edge cases here',
    'developer should validate input',
    'could possibly fail in some cases',
    'ensure proper error handling',
    'in general, this is fine',
    'more context is needed',
    'unable to determine without seeing other files',
    'you should consider refactoring',
    'enhance validation around the boundary',
    'it would be wise to add a fallback',
    'worth noting that this branch is untested',
  ])('flags hedging/slop: %s', (s) => {
    expect(isSlop(s)).toBe(true);
  });

  it.each([
    'No new test asserts that a 4xx status survives wrap_full_page.',
    'config.yml:165 sets pr_labels including "dependencies" but the PR adds no actual dep update.',
    'src/foo.js:42 dereferences userId before validating req.body is an object.',
    'The mutex is acquired but never released on the early-return path at line 88.',
    // Concrete claims that contain the words "could"/"might"/"should"/"may"
    // are no longer rejected wholesale — wave-1 LLM agent found that bare-word
    // matching dropped legitimate findings. The new rules look for hedging
    // *phrases* (e.g., "we should consider", "it might be wise"), not the
    // bare words.
    'this could panic on null deref at line 42',
    'function should not be called from async context — it blocks',
    'the loop may overflow when n exceeds Number.MAX_SAFE_INTEGER',
    'parseInt without radix might return NaN for hex strings',
  ])('passes a concrete claim: %s', (s) => {
    expect(isSlop(s)).toBe(false);
  });

  it('treats non-string as slop', () => {
    expect(isSlop(undefined)).toBe(true);
    expect(isSlop(null)).toBe(true);
    expect(isSlop(42)).toBe(true);
  });
});

describe('tryParseReview', () => {
  const happy = JSON.stringify({
    verdict: 'comment',
    summary: 'Adds a thing.',
    findings: [
      { file: 'src/a.js', line: 10, quoted_line: '+const x = 1;', claim: 'no test for x' }
    ]
  });

  it('parses a clean JSON response', () => {
    const r = tryParseReview(happy);
    expect(r.ok).toBe(true);
    expect(r.data.verdict).toBe('comment');
    expect(r.data.findings).toHaveLength(1);
  });

  it('strips markdown code fences', () => {
    const r = tryParseReview('```json\n' + happy + '\n```');
    expect(r.ok).toBe(true);
    expect(r.data.verdict).toBe('comment');
  });

  it('extracts a JSON object embedded in prose', () => {
    const r = tryParseReview('Here you go:\n\n' + happy + '\n\nThanks!');
    expect(r.ok).toBe(true);
  });

  it('rejects empty responses', () => {
    expect(tryParseReview('').ok).toBe(false);
    expect(tryParseReview('   ').ok).toBe(false);
  });

  it('rejects invalid JSON with no recoverable object', () => {
    expect(tryParseReview('not json at all').ok).toBe(false);
  });

  it('rejects unknown verdict values', () => {
    const bad = JSON.stringify({ verdict: 'maybe', summary: 'x', findings: [] });
    const r = tryParseReview(bad);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/invalid verdict/);
  });

  it('rejects null findings (would-be escape hatch)', () => {
    const bad = JSON.stringify({ verdict: 'approve', summary: 'x', findings: null });
    const r = tryParseReview(bad);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/findings must be an array/);
  });

  it('rejects findings with missing fields', () => {
    const bad = JSON.stringify({
      verdict: 'comment',
      summary: 'x',
      findings: [{ file: 'a', claim: 'b' }]  // missing line, quoted_line
    });
    expect(tryParseReview(bad).ok).toBe(false);
  });

  it('rejects findings with wrong-type fields', () => {
    const bad = JSON.stringify({
      verdict: 'comment',
      summary: 'x',
      findings: [{ file: 'a', line: 'ten', quoted_line: 'x', claim: 'y' }]
    });
    expect(tryParseReview(bad).ok).toBe(false);
  });

  it('rejects when verdict is missing', () => {
    const bad = JSON.stringify({ summary: 'x', findings: [] });
    expect(tryParseReview(bad).ok).toBe(false);
  });

  it('rejects an array (not object) as top-level', () => {
    expect(tryParseReview('[]').ok).toBe(false);
  });
});

describe('filterFindings (quote-or-die + slop drop)', () => {
  const diff = `
diff --git a/src/foo.js b/src/foo.js
+++ b/src/foo.js
@@ -1,3 +1,5 @@
+const id = req.body.userId;
+console.log("hi");
`;

  it('keeps findings whose quoted_line appears in diff and claim is concrete', () => {
    const findings = [{
      file: 'src/foo.js',
      line: 1,
      quoted_line: '+const id = req.body.userId;',
      claim: 'src/foo.js:1 trusts req.body.userId without validating it is a string.'
    }];
    expect(filterFindings(findings, diff)).toHaveLength(1);
  });

  it('drops findings whose quoted_line is not in the diff (paraphrase / hallucination)', () => {
    const findings = [{
      file: 'src/foo.js',
      line: 99,
      quoted_line: '+const userId = request.body.user_id;',  // close but not in diff
      claim: 'unvalidated input'
    }];
    expect(filterFindings(findings, diff)).toHaveLength(0);
  });

  it('drops findings with hedging language', () => {
    const findings = [{
      file: 'src/foo.js',
      line: 1,
      quoted_line: '+const id = req.body.userId;',
      claim: 'this might be an issue, consider validating it'
    }];
    expect(filterFindings(findings, diff)).toHaveLength(0);
  });

  it('drops findings with classic slop phrases', () => {
    const findings = [{
      file: 'src/foo.js',
      line: 1,
      quoted_line: '+const id = req.body.userId;',
      claim: 'developer should ensure proper error handling around this line'
    }];
    expect(filterFindings(findings, diff)).toHaveLength(0);
  });

  it('returns [] for non-array input', () => {
    expect(filterFindings(null, diff)).toEqual([]);
    expect(filterFindings(undefined, diff)).toEqual([]);
  });

  it('skips quote check when diff is empty (test-time helper)', () => {
    const findings = [{
      file: 'a', line: 1, quoted_line: 'whatever', claim: 'no slop here at line 1'
    }];
    expect(filterFindings(findings, '')).toHaveLength(1);
  });
});

describe('computeVerdict (deterministic, ignores model)', () => {
  it('returns approve for empty findings', () => {
    expect(computeVerdict([])).toBe('approve');
    expect(computeVerdict(undefined)).toBe('approve');
    expect(computeVerdict(null)).toBe('approve');
  });

  it('returns comment when only model findings exist', () => {
    expect(computeVerdict([{ file: 'a', line: 1, quoted_line: 'x', claim: 'y' }])).toBe('comment');
  });

  it('returns comment when oracle findings are warning/info only', () => {
    expect(computeVerdict([
      { source: 'oracle:rivet-validate', severity: 'warning', artifact_id: 'X', claim: 'y' }
    ])).toBe('comment');
  });

  it('promotes to request_changes when ANY oracle finding has severity error', () => {
    expect(computeVerdict([
      { source: 'oracle:rivet-validate', severity: 'warning', artifact_id: 'X', claim: 'a' },
      { source: 'oracle:rivet-validate', severity: 'error', artifact_id: 'Y', claim: 'b' }
    ])).toBe('request_changes');
  });

  it('does NOT promote to request_changes for model findings (no source) at "error" — only oracle has evidence-grade errors', () => {
    expect(computeVerdict([
      { file: 'a', line: 1, quoted_line: 'x', claim: 'y', severity: 'error' }
    ])).toBe('comment');
  });
});

describe('renderReviewMarkdown', () => {
  const meta = {
    baseRepo: 'org/repo', baseBranch: 'main',
    headRepo: 'org/repo', headBranch: 'fix/x'
  };

  it('returns null when verdict is approve and findings empty (silence preferred)', () => {
    const out = renderReviewMarkdown(
      { verdict: 'approve', summary: 'Doc only.', findings: [] },
      42, 'abc1234', meta
    );
    expect(out).toBeNull();
  });

  it('renders verdict + summary + findings when findings exist', () => {
    const out = renderReviewMarkdown(
      {
        verdict: 'comment',
        summary: 'Adds X.',
        findings: [{ file: 'a.js', line: 5, quoted_line: '+x', claim: 'no test for x at a.js:5' }]
      },
      42, 'abc1234', meta
    );
    expect(out).toContain('Automated review for PR #42');
    expect(out).toContain('💬 Comment');
    expect(out).toContain('Adds X.');
    expect(out).toContain('`a.js:5`');
    expect(out).toContain('no test for x');
    expect(out).toContain('abc1234');
  });

  it('forces verdict from findings even if model claimed otherwise', () => {
    // Model says approve but provides findings — verdict must be comment.
    const out = renderReviewMarkdown(
      {
        verdict: 'approve',  // ← model lied
        summary: 'Adds X.',
        findings: [{ file: 'a.js', line: 5, quoted_line: '+x', claim: 'no test for x at a.js:5' }]
      },
      42, 'abc1234', meta
    );
    expect(out).toContain('💬 Comment');
    expect(out).not.toContain('✅ Approve');
  });

  it('renders the new "Automated review" header with the HTML supersede marker', () => {
    const out = renderReviewMarkdown(
      {
        verdict: 'comment',
        summary: 'x',
        findings: [{ file: 'a.js', line: 1, quoted_line: '+x', claim: 'no test for x at a.js:1' }]
      },
      99, 'def5678', meta
    );
    expect(out).toContain('<!-- temper-automated-review -->');
    expect(out).toContain('## Automated review for PR #99');
    expect(out).not.toContain('## AI Code Review');
  });

  it('shows finding-source breakdown footer (mechanical vs AI)', () => {
    const out = renderReviewMarkdown(
      {
        verdict: 'comment',
        summary: 'mixed.',
        findings: [
          { source: 'oracle:rivet-validate', severity: 'warning', artifact_id: 'REQ-001', claim: 'REQ-001: foo' },
          { file: 'a.js', line: 1, quoted_line: '+x', claim: 'no test for x at a.js:1' }
        ]
      },
      99, 'def5678', meta
    );
    expect(out).toMatch(/_Findings: 1 mechanical \(rivet\) · 1 from local AI model\._/);
  });

  it('renders grouped oracle finding using artifact_ids array', () => {
    const out = renderReviewMarkdown(
      {
        verdict: 'comment',
        summary: 'group.',
        findings: [
          {
            source: 'oracle:rivet-validate',
            severity: 'warning',
            artifact_id: '3 artifacts',
            artifact_ids: ['REQ-1', 'REQ-2', 'REQ-3'],
            claim: 'no downstream — affecting: REQ-1, REQ-2, REQ-3'
          }
        ]
      },
      99, 'def5678', meta
    );
    expect(out).toContain('🟡 `3 artifacts`');
    expect(out).toContain('affecting: REQ-1, REQ-2, REQ-3');
  });

  it('renders oracle findings with severity badge and artifact_id (not file:line)', () => {
    const out = renderReviewMarkdown(
      {
        verdict: 'comment',
        summary: 'Run includes rivet validate.',
        findings: [
          {
            source: 'oracle:rivet-validate',
            severity: 'error',
            artifact_id: 'REQ-001',
            claim: 'REQ-001: missing required field x'
          },
          {
            source: 'oracle:rivet-impact',
            severity: 'warning',
            artifact_id: 'OLD-1',
            claim: 'Artifact removed: OLD-1.'
          }
        ]
      },
      99, 'def5678', meta
    );
    expect(out).toContain('🔴 `REQ-001`');
    expect(out).toContain('rivet-validate');
    expect(out).toContain('🟡 `OLD-1`');
    expect(out).toContain('rivet-impact');
    expect(out).toContain('🔴 Request changes');  // because severity:error oracle finding
  });

  it('renders mixed oracle + model findings in two visual styles', () => {
    const out = renderReviewMarkdown(
      {
        verdict: 'comment',
        summary: 'Mixed.',
        findings: [
          {
            source: 'oracle:rivet-validate',
            severity: 'warning',
            artifact_id: 'REQ-100',
            claim: 'REQ-100: lifecycle gap'
          },
          { file: 'a.js', line: 5, quoted_line: '+x', claim: 'no test for x at a.js:5' }
        ]
      },
      99, 'def5678', meta
    );
    expect(out).toContain('🟡 `REQ-100`');
    expect(out).toContain('`a.js:5`');
  });

  it('still posts when caller opts out of skip-approve-empty', () => {
    const out = renderReviewMarkdown(
      { verdict: 'approve', summary: 'Doc only.', findings: [] },
      42, 'abc1234', meta,
      { skipApproveEmpty: false }
    );
    expect(out).toContain('✅ Approve');
    expect(out).toContain('**Findings:** None.');
  });
});
