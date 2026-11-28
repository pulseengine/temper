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
 *   required_unmatched         a required context that should come from a
 *                              workflow (reusable-shaped "<caller> / <called>",
 *                              or bound to GitHub Actions) matches no job, so
 *                              nothing above was evaluated for it
 *   verdict_unbaselined        jig split verdicts (v0.1.4): no required verdict
 *                              from pulseengine/jig's required.yml hosts the
 *                              baseline (every baseline-job is "" or an
 *                              expression), or a named baseline-job is not a
 *                              job calling jig's baseline.yml at the same sha
 *   probe_workflow_skippable   the workflow that runs the gate-probe action
 *                              can be skipped or weakened: a pull_request
 *                              filter, an `if:`, pull_request_target, or an
 *                              action ref that is not a full commit sha; in
 *                              a public repo, also a self-hosted runs-on
 *                              that does not route fork PRs elsewhere
 * A job calling a local reusable workflow, or a same-org one pinned to a
 * full commit sha (read at that sha, temper#103), is expanded into its
 * called jobs, named "<caller> / <called>", before the rules run (temper#100).
 * Whether a detector itself fails closed is the behavioural probe's job
 * (.github/actions/gate-probe): source text cannot show it.
 */

import yaml from 'js-yaml';

export const PROBE_CONTRACT = '.github/gate-probe.json';

export function triggers(doc) {
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

const LOCAL_REUSABLE = /^\.\/(\.github\/workflows\/[^@\s]+\.ya?ml)$/;
const REMOTE_REUSABLE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(\.github\/workflows\/[^@\s]+\.ya?ml)@(\S+)$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Every remote reusable-workflow call in these workflow files, deduplicated
 * by its `uses` string. `fetchable` is true only for a call into `owner`'s
 * own org pinned to a full commit sha: that text cannot change under the
 * pin. Anything else gets a `reason` and is not read.
 */
export function remoteReusableCalls(files, owner) {
  const calls = new Map();
  for (const f of files) {
    let doc;
    try {
      doc = yaml.load(f.text);
    } catch {
      continue;
    }
    if (!doc?.jobs || typeof doc.jobs !== 'object') continue;
    for (const job of Object.values(doc.jobs)) {
      const uses = String(job?.uses ?? '');
      const m = REMOTE_REUSABLE.exec(uses);
      if (!m || calls.has(uses)) continue;
      const [, o, repo, path, ref] = m;
      const reason = o.toLowerCase() !== String(owner).toLowerCase() ? `another org (${o}) is not read`
        : !FULL_SHA.test(ref) ? `ref "${ref}" is not a full commit sha, so it is not read`
          : undefined;
      calls.set(uses, { uses, owner: o, repo, path, ref, fetchable: !reason, ...(reason ? { reason } : {}) });
    }
  }
  return [...calls.values()];
}
const both = (a, b) => (a && b ? `(${a}) && (${b})` : a || b || undefined);

/**
 * A job that calls a local reusable workflow reports one check run per called
 * job, named "<caller> / <called>". Each becomes a job of the caller's
 * workflow that runs under the caller's `needs` and both `if:`s, with both
 * texts, so the rules below see what decides it. A remote workflow is
 * expanded only from `remote` (parsed texts keyed by the exact `uses`);
 * an unread one surfaces as required_unmatched.
 */
function expandReusable(out, remote = new Map()) {
  const byPath = new Map(out.map((w) => [w.path, w]));
  for (const wf of out) {
    for (const [id, { job }] of Object.entries(wf.jobs)) {
      const uses = String(job.uses ?? '');
      const m = LOCAL_REUSABLE.exec(uses);
      const called = m ? byPath.get(m[1]) : remote.get(uses);
      if (!called || called === wf) continue;
      const callerName = typeof job.name === 'string' ? job.name : id;
      for (const [cid, { job: cjob }] of Object.entries(called.jobs)) {
        if (cjob.uses) continue; // nested reusable calls: not expanded
        const name = `${callerName} / ${typeof cjob.name === 'string' ? cjob.name : cid}`;
        const synth = { ...cjob, name, needs: job.needs, if: both(job.if, cjob.if), caller: job };
        wf.jobs[`${id}/${cid}`] = { job: synth, matches: contextMatcher(cid, synth), reusable: called.path };
      }
    }
  }
  return out;
}

/**
 * Parse workflows into { path, doc, on, jobs: {id: {job, matches}} };
 * unparsable files are skipped. `remoteFiles` ({uses, text}) are the texts
 * of remote reusable workflows: they only expand their callers and are not
 * analysed as workflows of this repository.
 */
export function parseWorkflows(files, remoteFiles = []) {
  const remote = new Map(parseEach(remoteFiles.filter((r) => typeof r.text === 'string').map((r) => ({ path: r.uses, text: r.text })))
    .map((w) => [w.path, w]));
  return expandReusable(parseEach(files), remote);
}

function parseEach(files) {
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
 * @param {{probeContract?: boolean, publicRepo?: boolean, actionsContexts?: string[],
 *   remoteWorkflows?: {uses: string, text?: string, reason?: string}[]}} [opts]
 *   remoteWorkflows: remote reusable workflows, read (text) or not (reason)
 * @returns {{rule: string, workflow: string, job?: string, detail: string}[]}
 */
export function analyzeGateSkips(files, requiredContexts, { probeContract = false, publicRepo = false, actionsContexts = [], remoteWorkflows = [] } = {}) {
  const contract = readProbeContract(probeContract);
  const wfs = parseWorkflows(files, remoteWorkflows);
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
  hits.push(...verdictBaselineHits(wfs, required));

  // A required context no job produces was not analysed at all: say so
  // rather than return nothing. Scoped to contexts a workflow should produce
  // (reusable-shaped, or bound to GitHub Actions); another app's status is
  // not expected to match a job.
  const actions = new Set(actionsContexts);
  const why = new Map(remoteWorkflows.map((r) => [r.uses, r.reason ?? (typeof r.text === 'string' ? undefined : 'could not be read')]));
  for (const c of required) {
    if (!c.includes(' / ') && !actions.has(c)) continue;
    if (wfs.some((w) => Object.values(w.jobs).some((j) => j.matches(c)))) continue;
    // Name the remote call whose caller matches "<caller> / ...", and why it was not expanded.
    const caller = c.split(' / ')[0];
    let reason = 'a remote reusable workflow is read only when it is in this org and pinned to a full commit sha';
    for (const w of wfs) {
      for (const [id, { job }] of Object.entries(w.jobs)) {
        const name = typeof job.name === 'string' ? job.name : id;
        if (name !== caller || !REMOTE_REUSABLE.test(String(job.uses ?? ''))) continue;
        reason = `${job.uses}: ${!why.has(job.uses) ? 'not read' : why.get(job.uses) ?? 'read at the pin, but none of its jobs produces this name'}`;
      }
    }
    hits.push({ rule: 'required_unmatched', workflow: '(none)',
      detail: `no job in the default branch's workflows produces "${c}" (${reason})` });
  }
  return hits;
}

/**
 * The ref of a call to pulseengine/jig's workflow `file`, else null. Owner
 * and repository compare without case, as GitHub resolves them; the path
 * is case-sensitive. Shares REMOTE_REUSABLE with the fetch, so a spelling
 * the fetch expands is one this rule sees.
 */
function jigCall(uses, file) {
  const m = REMOTE_REUSABLE.exec(String(uses ?? ''));
  return m && m[1].toLowerCase() === 'pulseengine' && m[2].toLowerCase() === 'jig'
    && m[3] === `.github/workflows/${file}` ? m[4] : null;
}

/**
 * jig v0.1.4 lets a repository split its verdict across workflows; a caller
 * passing `baseline-job: ""` defers the baseline to another required
 * verdict. jig sees one workflow, so the cross-workflow rule is checked
 * here (temper#106): among the required contexts produced by jig's
 * required.yml, at least one caller must name a baseline job (default
 * "baseline") in its own workflow that calls jig's baseline.yml at the same
 * sha. An expression cannot be read statically and counts as hosting none.
 */
function verdictBaselineHits(wfs, required) {
  const callers = new Map();
  for (const w of wfs) {
    for (const { job, matches } of Object.values(w.jobs)) {
      const sha = job.caller && jigCall(job.caller.uses, 'required.yml');
      if (!sha || ![...required].some((c) => matches(c))) continue;
      const id = Object.keys(w.jobs).find((k) => w.jobs[k].job === job.caller);
      callers.set(`${w.path}#${id}`, { w, id, caller: job.caller, sha });
    }
  }
  if (!callers.size) return [];
  const hits = [];
  let hosted = false;
  const deferred = [];
  for (const { w, id, caller, sha } of callers.values()) {
    const raw = caller.with?.['baseline-job'];
    const bj = raw === undefined || raw === null ? 'baseline' : String(raw);
    if (bj === '' || bj.includes('${{')) {
      deferred.push(`${w.path}#${id} (${bj === '' ? 'baseline-job ""' : 'baseline-job is an expression'})`);
      continue;
    }
    const want = `pulseengine/jig/.github/workflows/baseline.yml@${sha}`;
    const got = w.jobs[bj]?.job?.uses;
    if (got !== undefined && jigCall(got, 'baseline.yml') === sha) {
      hosted = true;
      continue;
    }
    hits.push({ rule: 'verdict_unbaselined', workflow: w.path, job: id,
      detail: got === undefined
        ? `baseline-job "${bj}" is not a job of this workflow`
        : `baseline-job "${bj}" calls ${got || 'no reusable workflow'}, not ${want}` });
  }
  if (!hosted && !hits.length) {
    hits.push({ rule: 'verdict_unbaselined', workflow: deferred[0].split('#')[0],
      detail: `no required jig verdict hosts the baseline: ${deferred.join(', ')}` });
  }
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
