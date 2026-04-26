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
  return {
    source: 'oracle:rivet-validate',
    severity: 'warning',
    artifact_id: id,
    claim: `${id} (${gap.type || 'artifact'}) — ${gap.reason || gap.message || 'lifecycle coverage gap: no downstream artifacts'}`
  };
}

/**
 * Convert broken cross-refs / circular deps into findings.
 */
function brokenCrossRefToFinding(ref) {
  const from = ref?.from || ref?.source || 'unknown';
  const to = ref?.to || ref?.target || 'unknown';
  return {
    source: 'oracle:rivet-validate',
    severity: 'error',
    artifact_id: from,
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
