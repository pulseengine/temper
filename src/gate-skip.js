/**
 * Does a skipped required check stand for "nothing to test", or can it hide
 * a change that matters? GitHub counts a skipped job as a passing required
 * check, so the path filters and change detectors in front of a required
 * check decide what is gated. A filter that lists what counts as code fails
 * open; one that lists what is NOT code fails closed.
 *
 * This is the static half (read-only, workflow YAML only):
 *   paths_ignore_dir_wildcard  a required workflow ignores `dir/**`, which
 *                              matches every file type under dir
 *   paths_allowlist            a required workflow runs only on listed
 *                              `paths`; its stub passes everything else
 *   stub_mismatch              a not-applicable stub's `paths` differs from
 *                              the real workflow's `paths-ignore` (or back)
 *   aggregate_accepts_skip     an `if: always()` gate needs a job a detector
 *                              can skip, without reading the detector
 *   detector_unprobed          a required check can be skipped by a change
 *                              detector the repo has not declared in
 *                              .github/gate-probe.json (or the file is not
 *                              valid JSON)
 *   output_unprobed            a detector output that gates a required check
 *                              is neither in a detector's `outputs` nor in
 *                              its `exempt_outputs` (with a reason)
 *   probe_workflow_skippable   the workflow that runs the gate-probe action
 *                              can be skipped or weakened: a pull_request
 *                              filter, an `if:`, pull_request_target, or an
 *                              action ref that is not a full commit sha; in
 *                              a public repo, also a self-hosted runs-on
 *                              that does not route fork PRs elsewhere
 * Whether a detector itself fails closed is the behavioural probe's job
 * (.github/actions/gate-probe): source text cannot show it.
 */

import yaml from 'js-yaml';

export const PROBE_CONTRACT = '.github/gate-probe.json';

function triggers(doc) {
  const on = doc?.on ?? doc?.true; // YAML 1.1 reads a bare `on:` key as true
  if (typeof on === 'string') return { [on]: {} };
  if (Array.isArray(on)) return Object.fromEntries(on.map((e) => [e, {}]));
  return on && typeof on === 'object' ? on : {};
}

const asList = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);

/** A job's check-run name, as a matcher (matrix names become wildcards). */
function contextMatcher(id, job) {
  const name = typeof job?.name === 'string' ? job.name : id;
  if (!name.includes('${{')) return (c) => c === name;
  const re = new RegExp('^' + name.split(/\$\{\{[^}]*\}\}/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+') + '$');
  return (c) => re.test(c);
}

/** Parse workflows into { path, doc, on, jobs: {id: {job, matches}} }; unparsable files are skipped. */
export function parseWorkflows(files) {
  const out = [];
  for (const f of files) {
    let doc;
    try {
      doc = yaml.load(f.text);
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object' || !doc.jobs || typeof doc.jobs !== 'object') continue;
    const jobs = {};
    for (const [id, job] of Object.entries(doc.jobs)) {
      jobs[id] = { job: job || {}, matches: contextMatcher(id, job) };
    }
    out.push({ path: f.path, doc, on: triggers(doc), jobs });
  }
  return out;
}

const jobText = (job) => JSON.stringify(job);
const DETECTOR_REF = /needs\.([A-Za-z0-9_-]+)\.outputs\./g;

function detectorsIn(text) {
  return [...new Set([...String(text).matchAll(DETECTOR_REF)].map((m) => m[1]))];
}

const OUTPUT_REF = /needs\.[A-Za-z0-9_-]+\.outputs\.([A-Za-z0-9_-]+)/g;
function outputsIn(text) {
  return [...new Set([...String(text).matchAll(OUTPUT_REF)].map((m) => m[1]))];
}

/**
 * The probe contract as temper sees it: null when absent, {invalid: true}
 * when unreadable, else the output names it probes or exempts.
 */
export function readProbeContract(text) {
  if (text === null || text === undefined || text === false) return null;
  if (text === true) return { covered: null }; // present, content unknown
  try {
    const doc = JSON.parse(text);
    const covered = new Set();
    for (const d of Array.isArray(doc?.detectors) ? doc.detectors : []) {
      for (const o of Array.isArray(d?.outputs) ? d.outputs : []) covered.add(String(o));
      const ex = d?.exempt_outputs;
      if (ex && typeof ex === 'object' && !Array.isArray(ex)) {
        for (const [k, why] of Object.entries(ex)) if (typeof why === 'string' && why.trim()) covered.add(k);
      }
    }
    return { covered };
  } catch {
    return { invalid: true };
  }
}

/**
 * @param {{path: string, text: string}[]} files - workflow files
 * @param {string[]} requiredContexts - the default branch's required checks
 * @param {{probeContract?: boolean}} [opts]
 * @returns {{rule: string, workflow: string, job?: string, detail: string}[]}
 */
export function analyzeGateSkips(files, requiredContexts, { probeContract = false, publicRepo = false } = {}) {
  const contract = readProbeContract(probeContract);
  const wfs = parseWorkflows(files);
  const required = new Set(requiredContexts);
  const hits = [];
  const pairs = new Set();
  const requiredJobs = (wf) => Object.entries(wf.jobs)
    .filter(([, j]) => [...required].some((c) => j.matches(c)))
    .map(([id]) => id);

  const nameOf = (wf, id) => (typeof wf.jobs[id].job.name === 'string' ? wf.jobs[id].job.name : id);
  const sharesChecks = (a, reqA, b) => Object.values(b.jobs).some((j) => reqA.some((id) => j.matches(nameOf(a, id))));

  const filtered = (w) => { const p = w.on.pull_request || {}; return asList(p.paths).length > 0 || asList(p['paths-ignore']).length > 0; };
  const steps = (w) => Object.values(w.jobs).reduce((n, j) => n + asList(j.job.steps).length, 0);
  const isStub = (w, req) => filtered(w) &&
    wfs.some((o) => o !== w && filtered(o) && sharesChecks(w, req, o) && steps(o) > steps(w));

  for (const wf of wfs) {
    const req = requiredJobs(wf);
    if (req.length === 0) continue;
    const pr = wf.on.pull_request || {};
    const ignore = asList(pr['paths-ignore']);
    const only = asList(pr.paths);

    // A stub reports the real workflow's check names on the paths the real
    // one skips. Of a pair, the stub is the side with fewer steps; the
    // filter rules below are about the real workflow only.
    if (isStub(wf, req)) continue;
    if (only.length) {
      hits.push({ rule: 'paths_allowlist', workflow: wf.path, detail: `runs only on ${only.length} listed path(s)` });
    }
    for (const p of ignore) {
      if (/^[^!*][^*]*\/\*\*$/.test(String(p))) {
        hits.push({ rule: 'paths_ignore_dir_wildcard', workflow: wf.path, detail: `paths-ignore ${p}` });
      }
    }

    // A stub reports the same check names on exactly the paths the real
    // workflow skips: the real `paths-ignore` must equal the stub's `paths`
    // (and the real `paths` the stub's `paths-ignore`).
    const filter = ignore.length ? ['paths-ignore', ignore, 'paths'] : only.length ? ['paths', only, 'paths-ignore'] : null;
    if (filter) {
      const [mine, mineList, theirs] = filter;
      for (const other of wfs) {
        if (other === wf) continue;
        if (!sharesChecks(wf, req, other)) continue;
        const opr = other.on.pull_request || {};
        if (!opr.paths && !opr['paths-ignore']) continue; // not a stub
        const key = [wf.path, other.path].sort().join('|');
        if (pairs.has(key)) continue;
        pairs.add(key);
        const otherList = asList(opr[theirs]);
        const a = [...mineList].map(String).sort().join('\n');
        const b = [...otherList].map(String).sort().join('\n');
        if (a !== b) {
          hits.push({ rule: 'stub_mismatch', workflow: other.path,
            detail: `${theirs} differs from ${wf.path} ${mine}` });
        }
      }
    }

    // Detectors: jobs whose outputs decide whether another job runs.
    const skippable = new Map(); // job id -> detector ids
    for (const [id, j] of Object.entries(wf.jobs)) {
      const ds = detectorsIn(j.job.if ?? '');
      if (ds.length) skippable.set(id, ds);
    }

    for (const id of req) {
      const job = wf.jobs[id].job;
      const needs = asList(job.needs);
      const always = /always\(\)|!\s*cancelled\(\)/.test(String(job.if ?? ''));
      const text = jobText(job);
      if (always && needs.length) {
        const behind = needs.filter((n) => skippable.has(n));
        const detectors = [...new Set(behind.flatMap((n) => skippable.get(n)))];
        const reads = detectors.some((d) => text.includes(`needs.${d}.`));
        if (behind.length && !reads) {
          hits.push({ rule: 'aggregate_accepts_skip', workflow: wf.path, job: id,
            detail: `accepts skipped ${behind.join(',')} without reading ${detectors.join(',')}` });
        }
      }
      const direct = skippable.get(id) || [];
      const viaGate = always ? needs.flatMap((n) => skippable.get(n) || []) : [];
      const detectors = [...new Set([...direct, ...viaGate])];
      if (detectors.length && (!contract || contract.invalid)) {
        hits.push({ rule: 'detector_unprobed', workflow: wf.path, job: id,
          detail: `skippable by ${detectors.join(',')}; ${contract ? `${PROBE_CONTRACT} is not valid JSON` : `no ${PROBE_CONTRACT}`}` });
      } else if (detectors.length && contract.covered) {
        const gating = [job.if, ...(always ? needs.map((n) => wf.jobs[n]?.job.if) : [])].flatMap(outputsIn);
        const missing = [...new Set(gating)].filter((o) => !contract.covered.has(o));
        if (missing.length) {
          hits.push({ rule: 'output_unprobed', workflow: wf.path, job: id,
            detail: `gated by ${missing.join(',')}, neither probed nor exempted in ${PROBE_CONTRACT}` });
        }
      }
    }
  }
  hits.push(...probeWorkflowHits(wfs, { publicRepo }));
  return hits;
}

const PROBE_USES = /^pulseengine\/temper\/\.github\/actions\/gate-probe@(.*)$/;

/** A skipped job reports success, so the probe's own workflow must never skip. */
export function probeWorkflowHits(wfs, { publicRepo = false } = {}) {
  const hits = [];
  for (const wf of wfs) {
    for (const [id, { job }] of Object.entries(wf.jobs)) {
      const steps = asList(job.steps);
      const probeSteps = steps.filter((st) => PROBE_USES.test(String(st?.uses ?? '')));
      if (!probeSteps.length) continue;
      const problems = [];
      if (wf.on.pull_request_target !== undefined) problems.push('pull_request_target trigger');
      if (wf.on.pull_request === undefined) problems.push('no pull_request trigger');
      const pr = wf.on.pull_request || {};
      for (const k of ['paths', 'paths-ignore', 'branches', 'branches-ignore']) {
        if (pr[k] !== undefined) problems.push(`pull_request.${k}`);
      }
      if (job.if !== undefined) problems.push('job if:');
      for (const st of probeSteps) {
        if (st.if !== undefined) problems.push('step if:');
        if (st['continue-on-error'] !== undefined) problems.push('continue-on-error');
        const ref = String(st.uses).match(PROBE_USES)[1];
        if (!/^[0-9a-f]{40}$/.test(ref)) problems.push('action ref is not a full sha');
      }
      if (job['continue-on-error'] !== undefined) problems.push('job continue-on-error');
      // The probe runs the PR's own detector: in a public repo a fork PR
      // must not land on our self-hosted runners (owner decision 2026-11-10).
      const runsOn = JSON.stringify(job['runs-on'] ?? '');
      if (publicRepo && runsOn.includes('self-hosted') && !runsOn.includes('head.repo.fork')) {
        problems.push('self-hosted runs-on without fork routing');
      }
      if (problems.length) {
        hits.push({ rule: 'probe_workflow_skippable', workflow: wf.path, job: id, detail: problems.join(', ') });
      }
    }
  }
  return hits;
}
