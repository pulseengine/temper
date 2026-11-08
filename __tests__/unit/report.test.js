import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { getStandards, evaluateRepo } from '../../src/standards.js';
import { validateConfig } from '../../src/schema.js';
import {
  validateReport, writeReport, repoEntry, buildReport, summarize, iso, MAX_REPOS, MAX_CHECKS, MAX_BYTES
} from '../../src/report.js';
import {
  countReview, reviewTotals, recordApiResponse, apiSnapshot, trackOctokit, setReviewStatsStore, _resetReportStats
} from '../../src/report-stats.js';
import { createReportSweep, reportSettings, buildInfo } from '../../src/report-sweep.js';
import { initTaskStore } from '../../src/task-store.js';
import { initKVStore } from '../../src/persistent-kv.js';

const REPO_CONFIG = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'config.yml'), 'utf8'));
const std = () => getStandards(REPO_CONFIG);
const ADMIN = { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' };
const ok = (body) => ({ status: 200, body });
const err = (status, message) => ({ status, body: { message } });

/** warte src/temper/report.rs tests::sample(), verbatim: the contract fixture. */
function warteSample() {
  return {
    schema: 'temper-report.v1',
    generated_at: '2026-11-04T06:00:00Z',
    temper: { version: '2.4.0', commit: 'a'.repeat(40), config_sha256: 'b'.repeat(64) },
    org: 'pulseengine',
    source: { trigger: 'webhook', last_sweep_at: '2026-11-04T01:00:00Z',
      api: { calls_last_hour: 12, remaining: 4980, limit: 5000, reset_at: '2026-11-04T07:00:00Z' } },
    summary: { repos: 2, compliant: 1, noncompliant: 1, unknown: 0 },
    repos: [
      { name: 'warte', checked_at: '2026-11-04T05:59:00Z', default_branch: 'main',
        checks: [{ id: 'protection.present', ok: true, severity: 'critical', code: 'ok' }] },
      { name: 'spar', checked_at: '2026-11-04T05:00:00Z', default_branch: 'main',
        checks: [
          { id: 'protection.signed_commits', ok: false, severity: 'high', code: 'missing' },
          { id: 'dependabot.config', ok: null, severity: 'medium', code: 'error_permission' }
        ] }
    ],
    org_checks: [{ id: 'standards.drift', ok: false, severity: 'medium', code: 'divergent_undeclared' }],
    reviews: { window_days: 7, posted: 3, suppressed_no_findings: 5, findings: 4,
      dropped_unquoted: 1, rivet_oracle_runs: 2, errors: 0 },
    tasks: { pending: 0, in_progress: 0, failed: 1, oldest_pending_age_s: 0, stale_in_progress: 0 }
  };
}

function compliantSnapshot(name = 'good') {
  const managed = {
    id: 100, name: 'temper-default-branch-protection', target: 'branch', enforcement: 'active',
    source_type: 'Repository', conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'required_signatures' },
      { type: 'pull_request', parameters: {} },
      { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false,
        required_status_checks: [{ context: 'build' }, { context: 'hostname-scan' }] } }],
    bypass_actors: []
  };
  const tags = [
    { id: 901, name: 'immutable', target: 'tag', enforcement: 'active', source_type: 'Repository',
      conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
      rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'update' }], bypass_actors: [] },
    { id: 902, name: 'create', target: 'tag', enforcement: 'active', source_type: 'Repository',
      conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
      rules: [{ type: 'creation' }], bypass_actors: [ADMIN] }
  ];
  return {
    name,
    owner: 'pulseengine',
    repo: ok({ name, default_branch: 'main', private: false, fork: false, archived: false,
      allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false,
      allow_auto_merge: true, allow_update_branch: false, delete_branch_on_merge: true }),
    protection: ok({
      required_status_checks: { strict: false, contexts: ['build'], checks: [{ context: 'build' }] },
      enforce_admins: { enabled: true },
      required_signatures: { enabled: true },
      required_pull_request_reviews: { required_approving_review_count: 0 },
      required_linear_history: { enabled: false }
    }),
    branchRules: ok(managed.rules.map((r) => ({ ...r, ruleset_id: 100, ruleset_source_type: 'Repository' }))),
    rulesets: { status: 200, items: [managed, ...tags] },
    workflows: ok([{ name: 'ci.yml', path: '.github/workflows/ci.yml' },
      { name: 'hostname-scan.yml', path: '.github/workflows/hostname-scan.yml' }])
  };
}

const T = '2026-11-08T10:00:00Z';
const entry = (snap) => repoEntry(snap, evaluateRepo(snap, std()), T);
const byId = (e) => Object.fromEntries(e.checks.map((c) => [c.id, c]));

describe('validateReport mirrors warte\'s parser', () => {
  it('accepts warte\'s own sample report', () => {
    expect(validateReport(warteSample())).toBeNull();
  });

  // The same cases as warte's anything_but_enums_identifiers_times_and_hex_is_refused.
  const cases = [
    ['unknown field', (v) => { v.note = 'hello'; }],
    ['unknown nested field', (v) => { v.repos[0].title = 'x'; }],
    ['schema', (v) => { v.schema = 'temper-report.v2'; }],
    ['free text name', (v) => { v.repos[0].name = '<script>alert(1)</script>'; }],
    ['branch with space', (v) => { v.repos[0].default_branch = 'my branch'; }],
    ['unknown check id', (v) => { v.repos[0].checks[0].id = 'protection.whatever'; }],
    ['unknown code', (v) => { v.repos[0].checks[0].code = 'fine'; }],
    ['unknown severity', (v) => { v.org_checks[0].severity = 'urgent'; }],
    ['ok with an error code', (v) => { v.repos[1].checks[1].ok = true; }],
    ['null ok with a decided code', (v) => { v.repos[0].checks[0].ok = null; }],
    ['bad time', (v) => { v.generated_at = 'yesterday'; }],
    ['short commit', (v) => { v.temper.commit = 'abc'; }],
    ['version text', (v) => { v.temper.version = 'latest and greatest'; }],
    ['negative count', (v) => { v.tasks.failed = -1; }],
    ['trigger', (v) => { v.source.trigger = 'manual'; }],
    ['too many repos', (v) => { v.repos = Array(MAX_REPOS + 1).fill(v.repos[0]); }],
    ['too many checks', (v) => { v.repos[0].checks = Array(MAX_CHECKS + 1).fill(v.repos[0].checks[0]); }],
    ['missing field', (v) => { delete v.tasks.stale_in_progress; }]
  ];
  it.each(cases)('refuses: %s, without quoting the input', (_what, edit) => {
    const v = warteSample();
    edit(v);
    const e = validateReport(v);
    expect(e).toMatch(/^invalid /);
    expect(e).not.toMatch(/script|hello/);
  });

  it('a null last_sweep_at (never swept) is fine', () => {
    const v = warteSample();
    v.source.last_sweep_at = null;
    expect(validateReport(v)).toBeNull();
  });
});

describe('repoEntry maps standards findings to report checks', () => {
  it('positive control: a compliant repo reports only ok checks', () => {
    const e = entry(compliantSnapshot());
    expect(e.name).toBe('good');
    expect(e.default_branch).toBe('main');
    expect(e.checks.every((c) => c.ok === true && c.code === 'ok')).toBe(true);
    expect(Object.keys(byId(e))).toEqual(expect.arrayContaining([
      'protection.present', 'protection.enforce_admins', 'protection.required_checks',
      'protection.signed_commits', 'protection.required_reviews', 'ruleset.tag_v', 'merge.settings', 'merge.auto_merge']));
  });

  it('negative controls: each broken standard fails its own check', () => {
    let snap = compliantSnapshot();
    snap.protection.body.required_signatures.enabled = false;
    snap.branchRules.body = snap.branchRules.body.filter((r) => r.type !== 'required_signatures');
    expect(byId(entry(snap))['protection.signed_commits']).toMatchObject({ ok: false, code: 'missing', severity: 'high' });

    snap = compliantSnapshot();
    snap.protection.body.enforce_admins.enabled = false;
    expect(byId(entry(snap))['protection.enforce_admins']).toMatchObject({ ok: false, code: 'weaker_than_standard' });

    snap = compliantSnapshot();
    snap.repo.body.allow_rebase_merge = true;
    expect(byId(entry(snap))['merge.settings']).toMatchObject({ ok: false });

    snap = compliantSnapshot();
    snap.rulesets.items = snap.rulesets.items.filter((r) => r.target !== 'tag');
    expect(byId(entry(snap))['ruleset.tag_v']).toMatchObject({ ok: false, code: 'missing' });
  });

  it('an unreadable repo is undecided, not compliant', () => {
    const snap = compliantSnapshot('gone');
    snap.repo = err(403, 'Resource not accessible');
    const e = entry(snap);
    expect(e.checks).toEqual([{ id: 'protection.present', ok: null, severity: 'critical', code: 'error_permission' }]);
    expect(summarize([e])).toEqual({ repos: 1, compliant: 0, noncompliant: 0, unknown: 1 });
  });

  it('archived repos are left out; forks are not_applicable', () => {
    const a = compliantSnapshot('old');
    a.repo.body.archived = true;
    expect(entry(a)).toBeNull();
    const f = compliantSnapshot('fork');
    f.repo.body.fork = true;
    expect(entry(f).checks).toEqual([{ id: 'protection.present', ok: true, severity: 'critical', code: 'not_applicable' }]);
  });

  it('a report built from entries is one warte accepts', () => {
    const bad = compliantSnapshot('bad');
    bad.protection.body.enforce_admins.enabled = false;
    const repos = [entry(compliantSnapshot()), entry(bad)];
    const r = buildReport({
      org: 'pulseengine', now: Date.parse(T),
      build: { version: '1.0.0', commit: 'c'.repeat(40), config_sha256: 'd'.repeat(64) },
      source: { trigger: 'sweep', last_sweep_at: T, api: { calls_last_hour: 1, remaining: 2, limit: 3, reset_at: T } },
      repos,
      reviews: reviewTotals(7, Date.parse(T)),
      tasks: { pending: 0, in_progress: 0, failed: 0, oldest_pending_age_s: 0, stale_in_progress: 0 }
    });
    expect(validateReport(r)).toBeNull();
    expect(r.summary).toEqual({ repos: 2, compliant: 1, noncompliant: 1, unknown: 0 });
    expect(r.generated_at).toBe(T);
  });
});

describe('writeReport', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('writes 0640 atomically, leaving no temp file', () => {
    const file = path.join(dir, 'report.json');
    expect(writeReport(file, warteSample())).toMatchObject({ written: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(warteSample());
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(dir)).toEqual(['report.json']);
  });

  it('an invalid or oversized report keeps the previous file', () => {
    const file = path.join(dir, 'report.json');
    writeReport(file, warteSample());
    const before = fs.readFileSync(file, 'utf8');
    const v = warteSample();
    v.org = 'not an ident';
    expect(writeReport(file, v)).toEqual({ written: false, error: 'invalid org' });
    const big = warteSample();
    const one = big.repos[0];
    big.repos = Array.from({ length: MAX_REPOS }, (_, i) => ({ ...one, name: `r${i}`,
      checks: Array.from({ length: MAX_CHECKS }, () => one.checks[0]) }));
    expect(writeReport(file, big)).toEqual({ written: false, error: `larger than ${MAX_BYTES} bytes` });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(['report.json']);
  });
});

describe('report-stats', () => {
  afterEach(() => _resetReportStats());

  it('counts reviews per UTC day over the window', () => {
    const now = Date.parse(T);
    countReview('posted', 1, now);
    countReview('findings', 3, now);
    countReview('posted', 1, now - 3 * 86400000);
    countReview('posted', 1, now - 8 * 86400000); // outside a 7-day window
    countReview('bogus', 5, now);
    expect(reviewTotals(7, now)).toEqual({ window_days: 7, posted: 2, suppressed_no_findings: 0,
      findings: 3, dropped_unquoted: 0, rivet_oracle_runs: 0, errors: 0 });
  });

  it('review counters survive a restart through the KV store', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-'));
    const db = path.join(dir, 'kv.db');
    let kv = initKVStore(db, 'review_stats');
    setReviewStatsStore(kv);
    countReview('errors', 2);
    kv.close();
    _resetReportStats();
    kv = initKVStore(db, 'review_stats');
    setReviewStatsStore(kv);
    expect(reviewTotals().errors).toBe(2);
    kv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('counts API calls in the last hour and keeps the latest rate headers', () => {
    const now = Date.parse(T);
    recordApiResponse({ 'x-ratelimit-remaining': '4000', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1800000000' }, now - 2 * 3600000);
    recordApiResponse({}, now - 60000);
    recordApiResponse({ 'x-ratelimit-remaining': '3990', 'x-ratelimit-limit': '5000', 'x-ratelimit-reset': '1800000000' }, now);
    expect(apiSnapshot(now)).toEqual({ calls_last_hour: 2, rate: { remaining: 3990, limit: 5000, reset_at_ms: 1800000000000 } });
  });

  it('trackOctokit hooks a client once', () => {
    const hooks = [];
    const kit = { hook: { after: (n, f) => hooks.push(f), error: (n, f) => hooks.push(f) } };
    trackOctokit(kit);
    trackOctokit(kit);
    expect(hooks).toHaveLength(2);
    hooks[0]({ headers: {} });
    expect(apiSnapshot().calls_last_hour).toBe(1);
  });
});

describe('task-store getReportStats', () => {
  it('reports pending age and stale in_progress tasks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasks-'));
    const store = initTaskStore(path.join(dir, 'tasks.db'));
    store.enqueue('a', 'a:1', {});
    store.enqueue('b', 'b:1', {});
    store.enqueue('c', 'c:1', {}, { delayMs: 3600000 }); // not yet due
    store.claimNextTask();
    const later = Date.now() + 2 * 3600000;
    const s = store.getReportStats(later);
    expect(s.pending).toBe(2);
    expect(s.in_progress).toBe(1);
    expect(s.stale_in_progress).toBe(1);
    expect(s.oldest_pending_age_s).toBeGreaterThanOrEqual(3600);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('report sweep', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); _resetReportStats(); });

  function fakeOctokit(snaps, { listFails = false } = {}) {
    const route = (r, p = {}) => {
      const s = snaps[p.repo];
      const pick = {
        'GET /repos/{owner}/{repo}': s?.repo,
        'GET /repos/{owner}/{repo}/branches/{branch}/protection': s?.protection,
        'GET /repos/{owner}/{repo}/rules/branches/{branch}': s?.branchRules,
        'GET /repos/{owner}/{repo}/rulesets': s && ok(s.rulesets.items.map(({ id, name }) => ({ id, name }))),
        'GET /repos/{owner}/{repo}/contents/{path}': s?.workflows
      }[r];
      if (r === 'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}') {
        return ok(s.rulesets.items.find((x) => x.id === p.ruleset_id));
      }
      if (r === 'GET /rate_limit') return ok({ resources: { core: { remaining: 4900, limit: 5000, reset: 1800000000 } } });
      return pick || err(404, 'Not Found');
    };
    return {
      paginate: async () => {
        if (listFails) throw new Error('boom');
        return Object.values(snaps).map((s) => ({ name: s.name, full_name: `pulseengine/${s.name}`, archived: false }));
      },
      request: async (r, p) => {
        const res = route(r, p);
        if (res.status !== 200) throw Object.assign(new Error(res.body.message), { status: res.status });
        return { status: 200, data: res.body };
      }
    };
  }

  const config = (file) => ({ ...REPO_CONFIG, report: { enabled: true, path: file, sweep_interval_hours: 12 } });

  it('a completed sweep writes a report warte accepts and persists last_sweep_at', async () => {
    const file = path.join(dir, 'report.json');
    const kv = initKVStore(path.join(dir, 'kv.db'), 'report_state');
    const clock = () => Date.parse(T);
    const bad = compliantSnapshot('bad');
    bad.protection.body.enforce_admins.enabled = false;
    const sweep = createReportSweep({
      octokitFactory: async () => fakeOctokit({ good: compliantSnapshot('good'), bad }),
      org: 'pulseengine', stateStore: kv, config: config(file), clock
    });
    expect(sweep.due()).toBe(true);
    const res = await sweep.run();
    // A dev checkout may lack a 40-hex commit (e.g. a tarball); only then is the write refused.
    if (!/^[0-9a-f]{40}$/.test(buildInfo().commit)) {
      expect(res).toEqual({ written: false, error: 'invalid temper.commit' });
      return;
    }
    expect(res.written).toBe(true);
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(validateReport(r)).toBeNull();
    expect(r.source).toMatchObject({ trigger: 'sweep', last_sweep_at: T });
    expect(r.source.api).toMatchObject({ remaining: 4900, limit: 5000 });
    expect(r.repos.map((x) => x.name)).toEqual(['bad', 'good']);
    expect(r.summary).toEqual({ repos: 2, compliant: 1, noncompliant: 1, unknown: 0 });
    expect(sweep.due()).toBe(false);
    expect(Number(kv.get('last_sweep_at'))).toBe(Date.parse(T));
    // a restart reads it back
    const again = createReportSweep({ octokitFactory: async () => ({}), org: 'pulseengine', stateStore: kv, config: config(file), clock });
    expect(again.lastSweepAt).toBe(Date.parse(T));
    kv.close();
  });

  it('a sweep that cannot list repos keeps the previous file and last_sweep_at', async () => {
    const file = path.join(dir, 'report.json');
    fs.writeFileSync(file, 'previous');
    const sweep = createReportSweep({
      octokitFactory: async () => fakeOctokit({}, { listFails: true }),
      org: 'pulseengine', config: config(file), clock: () => Date.parse(T)
    });
    expect(await sweep.run()).toEqual({ written: false, error: 'boom' });
    expect(fs.readFileSync(file, 'utf8')).toBe('previous');
    expect(sweep.lastSweepAt).toBeNull();
  });

  it('settings: config.yml enables it; the env var overrides the path', () => {
    expect(validateConfig(REPO_CONFIG).valid).toBe(true);
    expect(reportSettings(REPO_CONFIG)).toMatchObject({ enabled: true, path: '/var/lib/temper/report.json', intervalMs: 12 * 3600000 });
    process.env.TEMPER_REPORT_PATH = '/tmp/x.json';
    expect(reportSettings(REPO_CONFIG).path).toBe('/tmp/x.json');
    delete process.env.TEMPER_REPORT_PATH;
    expect(validateConfig({ ...REPO_CONFIG, report: { path: 'relative' } }).valid).toBe(false);
  });

  it('iso() drops milliseconds', () => {
    expect(iso(Date.parse('2026-11-08T10:00:00.789Z'))).toBe('2026-11-08T10:00:00Z');
  });
});
