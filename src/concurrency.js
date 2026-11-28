/**
 * ci.concurrency (warte report check): does each workflow cancel superseded
 * PR runs, and are main and release runs safe from being cancelled?
 *
 * Requested by pulseengine.eu (2026-11-28) after superseded PR runs jammed the
 * hosted-runner queue. Report only: temper never writes the fix.
 *
 * Codes, one per repo, first match wins:
 *   release_cancellable  a tag, release or release-named dispatch workflow
 *                        whose cancel-in-progress is not false
 *   main_cancellable     a workflow that runs on push to the default branch or
 *                        on merge_group with cancel-in-progress: true
 *   pr_not_cancelled     a pull_request workflow without a ref-scoped group
 *                        that cancels on PR events, at the top level or on
 *                        every job
 *   error_parse          a workflow file that does not parse
 *   error_api / error_permission  the directory or a file could not be read
 *   ok / not_applicable  (no workflow files)
 */
import yaml from 'js-yaml';
import { triggers } from './gate-skip.js';

const ID = 'ci.concurrency';

// A group that differs per PR/branch, so one PR's runs never cancel another's.
const REF_SCOPED = /github\.(ref|head_ref|ref_name)\b|pull_request\.number|event\.number|github\.event\.pull_request/;
// An expression that is true for PR events only (kapsel's form and kin).
const PR_ONLY = /github\.event_name\s*==\s*'pull_request(_target)?'|github\.event_name\s*!=\s*'push'/;
const RELEASE_NAME = /release/i;

/**
 * How a concurrency block treats an in-progress run:
 * 'none' (no block), 'never', 'always', 'pr_only', or 'maybe' (another
 * expression: it may cancel, temper cannot tell when).
 */
export function cancelMode(conc) {
  if (conc === undefined || conc === null) return 'none';
  if (typeof conc === 'string') return 'never'; // group only
  if (typeof conc !== 'object') return 'never';
  const c = conc['cancel-in-progress'];
  if (c === undefined || c === false || c === 'false') return 'never';
  if (c === true || c === 'true') return 'always';
  if (typeof c === 'string') return PR_ONLY.test(c) ? 'pr_only' : 'maybe';
  return 'maybe';
}

function groupOf(conc) {
  if (typeof conc === 'string') return conc;
  return conc && typeof conc === 'object' ? String(conc.group ?? '') : '';
}

const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** push to the default branch: no filter, or a branches filter that names it or a wildcard. */
function pushesMain(push, defaultBranch) {
  if (push === undefined) return false;
  const p = push && typeof push === 'object' ? push : {};
  const branches = asList(p.branches);
  if (branches.length) return branches.some((b) => b === defaultBranch || b === '*' || b === '**');
  if (p['branches-ignore']) return !asList(p['branches-ignore']).includes(defaultBranch);
  return !p.tags && !p['tags-ignore']; // a tags-only filter does not run on branches
}

function pushesTags(push) {
  return !!(push && typeof push === 'object' && (asList(push.tags).length || push['tags-ignore']));
}

/** The modes that apply to a workflow's runs: the top level, else each job's. */
function modes(doc) {
  const jobs = doc.jobs && typeof doc.jobs === 'object' ? Object.values(doc.jobs) : [];
  if (doc.concurrency !== undefined) return [{ mode: cancelMode(doc.concurrency), group: groupOf(doc.concurrency) }];
  return jobs.map((j) => ({ mode: cancelMode(j?.concurrency), group: groupOf(j?.concurrency) }));
}

/**
 * The findings for one parsed workflow, as codes (possibly several).
 * @param {{path: string, doc: object}} wf
 */
export function workflowFindings({ path, doc }, defaultBranch = 'main') {
  const on = triggers(doc);
  const m = modes(doc);
  const out = [];
  const release = pushesTags(on.push) || on.release !== undefined ||
    (on.workflow_dispatch !== undefined && (RELEASE_NAME.test(path) || RELEASE_NAME.test(String(doc.name ?? ''))));
  if (release && m.some((x) => x.mode === 'always' || x.mode === 'maybe')) out.push('release_cancellable');
  const main = pushesMain(on.push, defaultBranch) || on.merge_group !== undefined;
  if (main && m.some((x) => x.mode === 'always')) out.push('main_cancellable');
  const pr = on.pull_request !== undefined || on.pull_request_target !== undefined;
  if (pr) {
    const cancels = (x) => (x.mode === 'always' || x.mode === 'pr_only' || x.mode === 'maybe') && REF_SCOPED.test(x.group);
    if (!m.length || !m.every(cancels)) out.push('pr_not_cancelled');
  }
  return out;
}

const RANK = ['release_cancellable', 'main_cancellable', 'pr_not_cancelled', 'error_parse'];

function errorCode(status) {
  return status === 401 || status === 403 || status === 404 ? 'error_permission' : 'error_api';
}

function check(code) {
  const undecided = code === 'error_api' || code === 'error_permission';
  return { id: ID, ok: undecided ? null : code === 'ok' || code === 'not_applicable', severity: 'medium', code };
}

/**
 * The ci.concurrency check for one snapshot, or null when the snapshot has
 * no workflow texts (an older sweep cache). Paths and the parse denominator
 * are for temper's log; the report carries the code alone.
 * @returns {{check: object, findings: Array<{path: string, code: string}>, parsed: number, total: number, unread: string[]}|null}
 */
export function ciConcurrency(snap) {
  if (!Array.isArray(snap.workflowTexts)) return null;
  const dir = snap.workflows?.status;
  const unreadList = Array.isArray(snap.workflowUnread) ? snap.workflowUnread : [];
  const total = snap.workflowTexts.length + unreadList.length;
  const empty = { findings: [], parsed: 0, total, unread: unreadList.map((u) => u.path) };
  if (dir === 404) return { check: check('not_applicable'), ...empty };
  if (dir !== 200) return { check: check(errorCode(dir)), ...empty };
  if (total === 0) return { check: check('not_applicable'), ...empty };
  const defaultBranch = snap.repo?.body?.default_branch || 'main';
  const findings = [];
  let parsed = 0;
  for (const f of snap.workflowTexts) {
    let doc;
    try {
      doc = yaml.load(f.text);
    } catch {
      doc = null;
    }
    if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object') {
      findings.push({ path: f.path, code: 'error_parse' });
      continue;
    }
    parsed++;
    for (const code of workflowFindings({ path: f.path, doc }, defaultBranch)) findings.push({ path: f.path, code });
  }
  let code = RANK.find((r) => findings.some((x) => x.code === r));
  if (!code && unreadList.length) code = errorCode(unreadList[0].status);
  return { check: check(code || 'ok'), findings, parsed, total, unread: empty.unread };
}
