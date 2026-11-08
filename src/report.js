/**
 * temper-report.v1: the compliance report warte shows.
 *
 * temper writes report.json; the warte probe on the same host forwards it.
 * The contract is warte's parser (warte src/temper/report.rs): every object
 * is closed, every string is an enum, an identifier, an RFC 3339 time or
 * hex, and anything over the caps rejects the whole report. This module
 * mirrors those rules so temper never writes a file warte would refuse.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { deriveState } from './standards.js';

export const SCHEMA = 'temper-report.v1';
export const MAX_BYTES = 1 << 20;
export const MAX_REPOS = 500;
export const MAX_CHECKS = 40;

export const CHECK_IDS = [
  'protection.present', 'protection.enforce_admins', 'protection.required_reviews',
  'protection.required_checks', 'protection.signed_commits', 'protection.linear_history',
  'ruleset.tag_v', 'merge.settings', 'merge.auto_merge', 'merge.relaxation_open',
  'dependabot.config', 'dependabot.config_valid', 'labels.synced', 'templates.present',
  'codeowners.present', 'secret_scanning', 'standards.drift'
];
export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
export const CODES = [
  'ok', 'missing', 'weaker_than_standard', 'stricter_than_standard', 'divergent_declared',
  'divergent_undeclared', 'not_applicable', 'error_api', 'error_permission', 'unknown'
];
const UNDECIDED = new Set(['unknown', 'error_api', 'error_permission']);

// standards.js finding rule → report check id and severity. Several rules can
// fold into one id (merge.settings); the check is ok only if all of them are.
const RULE_MAP = {
  required_checks: ['protection.required_checks', 'critical'],
  no_bypass: ['protection.enforce_admins', 'high'],
  required_signatures: ['protection.signed_commits', 'high'],
  pull_request: ['protection.required_reviews', 'high'],
  tag_protection: ['ruleset.tag_v', 'high'],
  merge_methods: ['merge.settings', 'medium'],
  update_branch: ['merge.settings', 'medium'],
  auto_merge: ['merge.auto_merge', 'medium']
};

const ABSENT = /^(none|false|absent|unknown|stub absent.*)$/;

function check(id, severity, code) {
  return { id, ok: UNDECIDED.has(code) ? null : code === 'ok' || code === 'not_applicable' || code === 'stricter_than_standard' || code === 'divergent_declared', severity, code };
}

function errorCode(status) {
  return status === 401 || status === 403 || status === 404 ? 'error_permission' : 'error_api';
}

/**
 * Map one evaluateRepo() result (and its snapshot) to a report repo entry.
 * Returns null for repos outside the report (archived).
 */
export function repoEntry(snap, evaluation, checkedAt) {
  const status = snap.repo?.status;
  if (status !== 200) {
    return {
      name: snap.name,
      checked_at: checkedAt,
      default_branch: 'main',
      checks: [check('protection.present', 'critical', errorCode(status))]
    };
  }
  if (evaluation.scope === 'archived') return null;
  const st = evaluation.state || deriveState(snap);
  const base = { name: snap.name, checked_at: checkedAt, default_branch: st.branch };

  if (evaluation.scope === 'fork' || evaluation.scope === 'unenforceable') {
    return { ...base, checks: [check('protection.present', 'critical', 'not_applicable')] };
  }

  const declared = evaluation.scope === 'held';
  const present = st.hasLegacy || st.branchRulesets.length > 0;
  const byId = new Map();
  byId.set('protection.present', check('protection.present', 'critical',
    present ? 'ok' : (declared ? 'divergent_declared' : 'missing')));

  const folded = new Map();
  for (const f of evaluation.findings) {
    const mapped = RULE_MAP[f.rule] || (f.rule === 'merge_queue' ? null : ['standards.drift', 'medium']);
    if (!mapped) continue;
    const [id, severity] = mapped;
    const prev = folded.get(id) || { severity, drift: false, absent: false };
    prev.drift = prev.drift || f.drift;
    prev.absent = prev.absent || (f.drift && ABSENT.test(String(f.actual)));
    folded.set(id, prev);
  }
  for (const [id, v] of folded) {
    let code = 'ok';
    if (v.drift) code = declared ? 'divergent_declared' : (v.absent ? 'missing' : 'weaker_than_standard');
    byId.set(id, check(id, v.severity, code));
  }
  return { ...base, checks: [...byId.values()].sort((a, b) => CHECK_IDS.indexOf(a.id) - CHECK_IDS.indexOf(b.id)) };
}

export function summarize(repos) {
  const s = { repos: repos.length, compliant: 0, noncompliant: 0, unknown: 0 };
  for (const r of repos) {
    if (r.checks.some((c) => c.ok === false)) s.noncompliant += 1;
    else if (r.checks.some((c) => c.ok === null)) s.unknown += 1;
    else s.compliant += 1;
  }
  return s;
}

/** Assemble the report object. All inputs are already-computed facts. */
export function buildReport({ org, now, build, source, repos, orgChecks = [], reviews, tasks }) {
  return {
    schema: SCHEMA,
    generated_at: iso(now),
    temper: build,
    org,
    source,
    summary: summarize(repos),
    repos,
    org_checks: orgChecks,
    reviews,
    tasks
  };
}

export function iso(ms) {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
}

// ── Validation: the same rules as warte's parser ─────────────────────────────

const ident = (s) => typeof s === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(s);
const hex = (s, n) => typeof s === 'string' && s.length === n && /^[0-9a-fA-F]+$/.test(s);
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const time = (s) => typeof s === 'string' && RFC3339.test(s) && !Number.isNaN(Date.parse(s));
const uint = (n) => Number.isSafeInteger(n) && n >= 0;
function semver(s) {
  if (typeof s !== 'string' || s.length > 64 || !/^[A-Za-z0-9.+-]+$/.test(s)) return false;
  const core = s.split(/[-+]/)[0].split('.');
  return core.length === 3 && core.every((p) => /^\d+$/.test(p));
}
function closed(obj, keys) {
  return obj !== null && typeof obj === 'object' && !Array.isArray(obj) &&
    Object.keys(obj).length === keys.length && keys.every((k) => k in obj);
}
function validCheck(c) {
  return closed(c, ['id', 'ok', 'severity', 'code']) && CHECK_IDS.includes(c.id) &&
    SEVERITIES.includes(c.severity) && CODES.includes(c.code) &&
    (c.ok === null ? UNDECIDED.has(c.code) : typeof c.ok === 'boolean' && !UNDECIDED.has(c.code));
}

/** @returns {string|null} the first violation, or null when warte would accept it. */
export function validateReport(r) {
  const bad = (what) => `invalid ${what}`;
  if (!closed(r, ['schema', 'generated_at', 'temper', 'org', 'source', 'summary', 'repos', 'org_checks', 'reviews', 'tasks'])) return bad('top level');
  if (r.schema !== SCHEMA) return bad('schema');
  if (!time(r.generated_at)) return bad('generated_at');
  if (!closed(r.temper, ['version', 'commit', 'config_sha256'])) return bad('temper');
  if (!semver(r.temper.version)) return bad('temper.version');
  if (!hex(r.temper.commit, 40)) return bad('temper.commit');
  if (!hex(r.temper.config_sha256, 64)) return bad('temper.config_sha256');
  if (!ident(r.org)) return bad('org');
  const s = r.source;
  if (!closed(s, ['trigger', 'last_sweep_at', 'api']) || !['webhook', 'sweep'].includes(s.trigger)) return bad('source');
  if (s.last_sweep_at !== null && !time(s.last_sweep_at)) return bad('source.last_sweep_at');
  const a = s.api;
  if (!closed(a, ['calls_last_hour', 'remaining', 'limit', 'reset_at']) ||
      ![a.calls_last_hour, a.remaining, a.limit].every(uint) || !time(a.reset_at)) return bad('source.api');
  if (!closed(r.summary, ['repos', 'compliant', 'noncompliant', 'unknown']) || !Object.values(r.summary).every(uint)) return bad('summary');
  if (!Array.isArray(r.repos) || r.repos.length > MAX_REPOS) return bad('repos');
  if (!Array.isArray(r.org_checks) || r.org_checks.length > MAX_CHECKS || !r.org_checks.every(validCheck)) return bad('org_checks');
  for (const [i, repo] of r.repos.entries()) {
    if (!closed(repo, ['name', 'checked_at', 'default_branch', 'checks']) || !ident(repo.name) ||
        !ident(repo.default_branch) || !time(repo.checked_at) || !Array.isArray(repo.checks) ||
        repo.checks.length > MAX_CHECKS || !repo.checks.every(validCheck)) return `invalid repos[${i}]`;
  }
  if (!closed(r.reviews, ['window_days', 'posted', 'suppressed_no_findings', 'findings', 'dropped_unquoted', 'rivet_oracle_runs', 'errors']) ||
      !Object.values(r.reviews).every(uint)) return bad('reviews');
  if (!closed(r.tasks, ['pending', 'in_progress', 'failed', 'oldest_pending_age_s', 'stale_in_progress']) ||
      !Object.values(r.tasks).every(uint)) return bad('tasks');
  return null;
}

/**
 * Validate, then write atomically (tmp + fsync + rename). An invalid or
 * oversized report never replaces the previous file.
 * @returns {{written: boolean, bytes?: number, error?: string}}
 */
export function writeReport(file, report) {
  const err = validateReport(report);
  if (err) return { written: false, error: err };
  const body = Buffer.from(JSON.stringify(report));
  if (body.length > MAX_BYTES) return { written: false, error: `larger than ${MAX_BYTES} bytes` };
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(tmp, 'w', 0o640);
  try {
    fs.writeSync(fd, body);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, 0o640);
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return { written: true, bytes: body.length };
}
