/**
 * Rivet mechanical oracle.
 *
 * Runs the `rivet` CLI on a checked-out repo tree and converts its JSON
 * output into Finding records the AI review pipeline can consume directly,
 * bypassing the model. These findings are *already* mechanically validated:
 * they cite real artifact IDs, were emitted by a deterministic tool, and
 * cannot be hallucinated.
 *
 * Two oracle modes:
 *   - validate: schema + traceability check. Reports per-artifact errors,
 *               warnings, broken cross-refs, lifecycle gaps.
 *   - impact:   diff against a baseline ref. Reports added/removed/changed
 *               artifacts plus the transitive closure of affected artifacts.
 *
 * The module deliberately does NOT clone the repo or install the binary —
 * that's the caller's job. Keeping side effects out makes it trivially
 * unit-testable with a fake `runner` injected in tests.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { getLogger } from './logger.js';

const execFileP = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60 * 1000;

/** Exit codes are not 0 for FAIL — but stdout still has the JSON. */
async function runCli(binary, args, opts = {}) {
  const { cwd, timeout = DEFAULT_TIMEOUT_MS, runner = execFileP } = opts;
  try {
    const { stdout } = await runner(binary, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout };
  } catch (err) {
    // Non-zero exit (e.g. validate FAIL) is expected — stdout is still valid JSON.
    if (err.stdout) return { ok: true, stdout: err.stdout, exitCode: err.code };
    return { ok: false, error: err.message, code: err.code };
  }
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Detect whether the given working tree is a rivet project.
 * Checks for `rivet.yaml` at the root.
 */
export function isRivetProject(repoPath) {
  return fs.existsSync(path.join(repoPath, 'rivet.yaml'));
}

/**
 * Convert a single rivet validate diagnostic into a Finding.
 * Severity 'info' is dropped — too noisy for code review.
 */
function diagnosticToFinding(diag) {
  if (!diag || diag.severity === 'info') return null;
  return {
    source: 'oracle:rivet-validate',
    severity: diag.severity,
    artifact_id: diag.artifact_id,
    // `message` is stored separately so we can group findings by message text.
    // `claim` is the rendered form used by the legacy code path that doesn't
    // group (kept for back-compat — tests assert on it).
    message: diag.message,
    claim: `${diag.artifact_id}: ${diag.message}`
  };
}

/**
 * Convert lifecycle-coverage gaps. Each gap is an artifact missing
 * downstream evidence — the slop signal we want to surface.
 */
function gapToFinding(gap) {
  if (!gap || typeof gap !== 'object') return null;
  const id = gap.artifact_id || gap.id;
  if (!id) return null;
  const reason = gap.reason || gap.message || 'lifecycle coverage gap: no downstream artifacts';
  return {
    source: 'oracle:rivet-validate',
    severity: 'warning',
    artifact_id: id,
    message: reason,
    claim: `${id} (${gap.type || 'artifact'}) — ${reason}`
  };
}

/**
 * Convert broken cross-refs / circular deps into findings.
 */
function brokenCrossRefToFinding(ref) {
  const from = ref?.from || ref?.source || 'unknown';
  const to = ref?.to || ref?.target || 'unknown';
  const message = `broken cross-reference → ${to}${ref?.reason ? ` (${ref.reason})` : ''}`;
  return {
    source: 'oracle:rivet-validate',
    severity: 'error',
    artifact_id: from,
    message,
    claim: `Broken cross-reference: ${from} → ${to}${ref?.reason ? ` (${ref.reason})` : ''}`
  };
}

/**
 * Run `rivet validate --format json` and convert diagnostics + gaps + broken
 * refs to Finding records. Returns:
 *
 *   {
 *     ok: true | false,
 *     result: 'PASS' | 'FAIL' | 'UNKNOWN',
 *     findings: Finding[],
 *     summary: { errors, warnings, ... },
 *     error?: string  // when ok = false
 *   }
 */
export async function runRivetValidate(binary, repoPath, opts = {}) {
  if (!isRivetProject(repoPath)) {
    return { ok: false, error: 'not a rivet project (no rivet.yaml at root)' };
  }
  const cliResult = await runCli(binary, ['validate', '--format', 'json'], {
    cwd: repoPath,
    timeout: opts.timeout,
    runner: opts.runner
  });
  if (!cliResult.ok) {
    getLogger().warn({ err: cliResult.error }, 'rivet validate failed to spawn');
    return { ok: false, error: cliResult.error || 'spawn failed' };
  }
  const data = safeParseJson(cliResult.stdout);
  if (!data) {
    return { ok: false, error: 'rivet validate did not emit parseable JSON' };
  }

  const findings = [];
  for (const d of data.diagnostics || []) {
    const f = diagnosticToFinding(d);
    if (f) findings.push(f);
  }
  for (const g of data.lifecycle_gaps || []) {
    const f = gapToFinding(g);
    if (f) findings.push(f);
  }
  for (const r of data.broken_cross_refs || []) {
    findings.push(brokenCrossRefToFinding(r));
  }

  return {
    ok: true,
    result: data.result || 'UNKNOWN',
    findings,
    summary: {
      errors: data.errors ?? 0,
      warnings: data.warnings ?? 0,
      infos: data.infos ?? 0,
      broken_cross_refs: (data.broken_cross_refs || []).length,
      circular_dependencies: (data.circular_dependencies || []).length,
      lifecycle_gaps: (data.lifecycle_gaps || []).length
    }
  };
}

/**
 * Run `rivet impact --since=<ref> --format json` and convert removed +
 * transitively-affected artifacts into findings. We intentionally do NOT
 * surface every `added` or `changed` artifact — those are diff metadata,
 * not concerns. We DO surface:
 *
 *   - removed artifacts (anything dropped from the trace graph is risky)
 *   - directly_affected (what this PR breaks the contract of)
 *
 * `transitively_affected` is included as a single summary finding when
 * non-empty; full list is too noisy for a PR comment.
 */
export async function runRivetImpact(binary, repoPath, baseRef, opts = {}) {
  if (!isRivetProject(repoPath)) {
    return { ok: false, error: 'not a rivet project (no rivet.yaml at root)' };
  }
  const cliResult = await runCli(
    binary,
    ['impact', '--since', baseRef, '--format', 'json'],
    { cwd: repoPath, timeout: opts.timeout, runner: opts.runner }
  );
  if (!cliResult.ok) {
    return { ok: false, error: cliResult.error || 'spawn failed' };
  }
  const data = safeParseJson(cliResult.stdout);
  if (!data) {
    return { ok: false, error: 'rivet impact did not emit parseable JSON' };
  }

  const findings = [];

  for (const id of data.removed || []) {
    findings.push({
      source: 'oracle:rivet-impact',
      severity: 'warning',
      artifact_id: id,
      claim: `Artifact removed: ${id}. Verify nothing downstream still depends on it.`
    });
  }

  for (const item of data.directly_affected || []) {
    const id = item?.id || 'unknown';
    const reason = Array.isArray(item?.reason) ? item.reason.join('; ') : '';
    const title = item?.title ? ` — ${item.title}` : '';
    findings.push({
      source: 'oracle:rivet-impact',
      severity: 'info',
      artifact_id: id,
      claim: `Directly affected: ${id}${title}${reason ? ` (${reason})` : ''}.`
    });
  }

  const transitiveCount = (data.transitively_affected || []).length;
  if (transitiveCount > 0) {
    findings.push({
      source: 'oracle:rivet-impact',
      severity: 'info',
      artifact_id: '<summary>',
      claim: `${transitiveCount} additional artifacts transitively affected by this PR. Run \`rivet impact --since=${baseRef}\` for the full list.`
    });
  }

  return {
    ok: true,
    findings,
    summary: data.summary || {
      added: (data.added || []).length,
      removed: (data.removed || []).length,
      changed: (data.changed || []).length,
      direct: (data.directly_affected || []).length,
      transitive: (data.transitively_affected || []).length
    }
  };
}

/**
 * Stable identity key for a finding. Used by `subtractFindings` so the
 * "is this finding new?" question is decidable without false-positive churn.
 *
 * The key intentionally excludes claim text (which is rendered) and severity
 * upgrades (a warning at base that becomes an error at head is treated as
 * "the same finding", since it's the same artifact + same message).
 */
export function findingKey(f) {
  if (!f) return '';
  return `${f.source || ''}|${f.artifact_id || ''}|${f.message || f.claim || ''}`;
}

/**
 * Set difference: keep only findings present at HEAD but not at BASE.
 * The whole point of PR review is "what did this PR change", not "what's
 * the static state of the project". Pre-existing diagnostics get filtered.
 */
export function subtractFindings(headFindings, baseFindings) {
  if (!Array.isArray(baseFindings) || baseFindings.length === 0) return headFindings;
  const baseKeys = new Set(baseFindings.map(findingKey));
  return headFindings.filter((f) => !baseKeys.has(findingKey(f)));
}

/**
 * Collapse oracle findings that share the same source + severity + message
 * into a single finding listing all affected artifact_ids. Today's spar#175
 * review had 91 findings with 6 unique messages — this turns that into 6
 * grouped findings with id lists.
 *
 * Non-oracle findings (model output) are passed through untouched.
 */
export function groupOracleFindings(findings, opts = {}) {
  const { maxIdsShown = 10 } = opts;
  if (!Array.isArray(findings) || findings.length === 0) return [];

  const groups = new Map();
  const out = [];

  for (const f of findings) {
    if (!f.source || !f.source.startsWith('oracle:')) {
      out.push(f);
      continue;
    }
    if (!f.message) {
      out.push(f);
      continue;
    }
    const key = `${f.source}|${f.severity}|${f.message}`;
    if (!groups.has(key)) {
      groups.set(key, {
        source: f.source,
        severity: f.severity,
        message: f.message,
        artifact_ids: []
      });
    }
    groups.get(key).artifact_ids.push(f.artifact_id);
  }

  for (const g of groups.values()) {
    if (g.artifact_ids.length === 1) {
      out.push({
        source: g.source,
        severity: g.severity,
        artifact_id: g.artifact_ids[0],
        message: g.message,
        claim: `${g.artifact_ids[0]}: ${g.message}`
      });
    } else {
      const shown = g.artifact_ids.slice(0, maxIdsShown).join(', ');
      const more = g.artifact_ids.length > maxIdsShown
        ? ` (+${g.artifact_ids.length - maxIdsShown} more)`
        : '';
      out.push({
        source: g.source,
        severity: g.severity,
        artifact_id: `${g.artifact_ids.length} artifacts`,
        artifact_ids: g.artifact_ids,
        message: g.message,
        claim: `${g.message} — affecting: ${shown}${more}`
      });
    }
  }
  return out;
}

/**
 * One-shot helper: run both validate and impact (when baseRef given), merge
 * findings, return a single result. Errors from either are non-fatal —
 * findings from the surviving call are still returned.
 */
export async function runRivetOracle(binary, repoPath, opts = {}) {
  if (!isRivetProject(repoPath)) {
    return { ok: false, applicable: false, error: 'not a rivet project' };
  }

  const validate = await runRivetValidate(binary, repoPath, opts);
  let impact = null;
  if (opts.baseRef) {
    impact = await runRivetImpact(binary, repoPath, opts.baseRef, opts);
  }

  const findings = [];
  if (validate.ok) findings.push(...validate.findings);
  if (impact?.ok) findings.push(...impact.findings);

  return {
    ok: true,
    applicable: true,
    validate: validate.ok ? { result: validate.result, summary: validate.summary } : { error: validate.error },
    impact: impact ? (impact.ok ? { summary: impact.summary } : { error: impact.error }) : null,
    findings
  };
}
