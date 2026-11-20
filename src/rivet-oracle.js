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

/** rivet output fields change shape across versions; iterate only lists. */
function asArray(v) {
  return Array.isArray(v) ? v : [];
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
  const missing = asArray(gap.missing).filter((m) => typeof m === 'string');
  const reason = gap.reason || gap.message ||
    (missing.length
      ? `lifecycle coverage gap: no downstream ${missing.join(', ')}`
      : 'lifecycle coverage gap: no downstream artifacts');
  return {
    source: 'oracle:rivet-validate',
    severity: 'warning',
    artifact_id: id,
    message: reason,
    claim: `${id} (${gap.artifact_type || gap.type || 'artifact'}) — ${reason}`
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
  for (const d of asArray(data.diagnostics)) {
    const f = diagnosticToFinding(d);
    if (f) findings.push(f);
  }
  // rivet 0.41+ reports lifecycle_gaps as a COUNT and the gaps themselves
  // as lifecycle_coverage; older rivet put the list under lifecycle_gaps.
  const gaps = Array.isArray(data.lifecycle_gaps) ? data.lifecycle_gaps : asArray(data.lifecycle_coverage);
  for (const g of gaps) {
    const f = gapToFinding(g);
    if (f) findings.push(f);
  }
  for (const r of asArray(data.broken_cross_refs)) {
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
      broken_cross_refs: asArray(data.broken_cross_refs).length,
      circular_dependencies: asArray(data.circular_dependencies).length,
      lifecycle_gaps: gaps.length
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

  for (const item of asArray(data.removed)) {
    const id = typeof item === 'string' ? item : item?.id || 'unknown';
    findings.push({
      source: 'oracle:rivet-impact',
      severity: 'warning',
      artifact_id: id,
      claim: `Artifact removed: ${id}. Verify nothing downstream still depends on it.`
    });
  }

  for (const item of asArray(data.directly_affected)) {
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

  const transitiveCount = asArray(data.transitively_affected).length;
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
      added: asArray(data.added).length,
      removed: asArray(data.removed).length,
      changed: asArray(data.changed).length,
      direct: asArray(data.directly_affected).length,
      transitive: asArray(data.transitively_affected).length
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

/**
 * The version the binary reports (`rivet 0.41.1 (...)` → "0.41.1"), or null.
 */
export async function rivetBinaryVersion(binary, opts = {}) {
  const r = await runCli(binary, ['--version'], { timeout: 10000, runner: opts.runner });
  if (!r.ok) return null;
  const m = String(r.stdout || '').match(/^rivet (\S+)/m);
  return m ? m[1] : null;
}

/**
 * May the oracle run for this repo (temper#94)? Findings from a different
 * rivet than the one the repo's own CI runs contradict that CI, so the
 * binary must report the configured version and the repo must pin the
 * configured varve layer. Anything missing or different: skip. Pure.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function oracleVersionGate({ configured, binaryVersion, repoLayer }) {
  if (!configured?.version || !configured?.layer) {
    return { ok: false, reason: 'rivet_oracle.version and rivet_oracle.layer are not configured' };
  }
  if (binaryVersion !== configured.version) {
    return {
      ok: false,
      reason: `the binary reports rivet ${binaryVersion ?? 'unknown'}, the config expects ${configured.version}`
    };
  }
  if (!repoLayer) {
    return { ok: false, reason: 'the repository pins no varve layer (varve.toml)' };
  }
  if (repoLayer !== configured.layer) {
    return {
      ok: false,
      reason: `the repository pins layer ${repoLayer}, the oracle runs layer ${configured.layer}`
    };
  }
  return { ok: true };
}

// ── Per-repo rivet (temper#94 follow-up) ─────────────────────────────────
//
// Every repo moves its own varve pin, so one configured layer matches almost
// none of them. Instead the oracle resolves the rivet each repo pins, through
// varve, in a pin directory temper writes itself. Only two strings come from
// the repository (realm name, layer) plus the channel, each validated; the
// realm definitions, which carry the trust root, come from the deploy's own
// realms file and never from the repository. A fork PR therefore cannot point
// temper at a realm whose key it controls. temper never installs: a layer the
// host has not laid down is a skip with a reason.

const PIN_REALM_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PIN_CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PIN_LAYER_RE = /^\d{4}\.\d{1,2}\.\d{1,2}$/;

/**
 * realm, channel and layer from the [toolchain] table of a varve.toml, or
 * null. Pure; a deliberately narrow reader (quoted string values only).
 */
export function parseVarvePin(text) {
  if (typeof text !== 'string') return null;
  let inToolchain = false;
  const pin = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const table = line.match(/^\[([^\]]+)\]$/);
    if (table) {
      inToolchain = table[1].trim() === 'toolchain';
      continue;
    }
    if (!inToolchain) continue;
    const kv = line.match(/^(realm|channel|layer)\s*=\s*"([^"]*)"$/);
    if (kv) pin[kv[1]] = kv[2];
  }
  return pin.layer ? pin : null;
}

/**
 * May temper resolve rivet for this pin? Pure.
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateVarvePin(pin, realmsAllowed) {
  if (!pin) return { ok: false, reason: 'the repository pins no varve layer (varve.toml)' };
  const { realm, channel, layer } = pin;
  if (!realm || !PIN_REALM_RE.test(realm)) {
    return { ok: false, reason: 'the varve pin names no valid realm' };
  }
  if (!Array.isArray(realmsAllowed) || !realmsAllowed.includes(realm)) {
    return { ok: false, reason: `realm ${realm} is not in rivet_oracle.realms_allowed` };
  }
  if (!channel || !PIN_CHANNEL_RE.test(channel)) {
    return { ok: false, reason: 'the varve pin names no valid channel' };
  }
  if (!PIN_LAYER_RE.test(layer)) {
    return { ok: false, reason: 'the varve pin names no valid layer' };
  }
  return { ok: true };
}

/**
 * The rivet binary the pin resolves to on this host, via `varve which rivet`
 * in `<pinsDir>/<realm>/<channel>/<layer>/`, against the store
 * `<storesDir>/<realm>/<channel>/<layer>`. Writes that directory's
 * varve.toml from the validated pin and copies the trusted realms file next
 * to it on every call. The pin must already have passed validateVarvePin.
 *
 * @returns {Promise<{ok: true, binary: string} | {ok: false, reason: string}>}
 */
export async function resolvePinnedRivet({ pin, varveBinary, pinsDir, storesDir, realmsFile, runner = execFileP }) {
  const label = `${pin.realm}/${pin.layer}`;
  const dir = path.join(pinsDir, pin.realm, pin.channel, pin.layer);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(
      path.join(dir, 'varve.toml'),
      `manifest-version = 1\n\n[toolchain]\nrealm   = "${pin.realm}"\nchannel = "${pin.channel}"\nlayer   = "${pin.layer}"\n`
    );
    await fs.promises.copyFile(realmsFile, path.join(dir, 'varve-realms.toml'));
  } catch (err) {
    return { ok: false, reason: `cannot prepare the pin directory for ${label}: ${err.message}` };
  }
  // One varve store per pin: anti-rollback is per line per store (varve#256),
  // so a shared store refuses older pins once a newer layer is installed.
  const env = { ...process.env, VARVE_ROOT: path.join(storesDir, pin.realm, pin.channel, pin.layer) };
  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await runner(varveBinary, ['which', 'rivet'], { cwd: dir, env, timeout: 10000 }));
  } catch (err) {
    const msg = String(err.stderr || err.message || '');
    if (/is not installed/.test(msg)) {
      return { ok: false, reason: `layer ${label} is not installed on this host` };
    }
    return { ok: false, reason: `varve which rivet failed for ${label}: ${msg.trim().split('\n')[0]}` };
  }
  // varve 0.47 prints the binary on stdout and the layer it resolved on
  // stderr (`layer <name> (<channel>) sha256:...`); it must be the pinned one.
  const binary = String(stdout || '').trim().split('\n')[0];
  const resolvedLayer = `${stdout || ''}\n${stderr || ''}`
    .split('\n')
    .some((l) => l.trim().startsWith(`layer ${pin.layer} `));
  if (!binary || !path.isAbsolute(binary) || !resolvedLayer) {
    return { ok: false, reason: `varve which rivet gave unexpected output for ${label}` };
  }
  return { ok: true, binary };
}
