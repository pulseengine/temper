import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import {
  getStandards,
  validateStandards,
  deriveState,
  evaluateRepo,
  hasDrift,
  intendedContexts,
  buildManagedRuleset,
  buildTagImmutableRuleset,
  buildTagCreateRuleset,
  enforceStandards,
  fetchSnapshot,
  loadSnapshotDir,
  renderWorkflowTemplate
} from '../../src/standards.js';
import { validateConfig } from '../../src/schema.js';

const REPO_CONFIG = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'config.yml'), 'utf8'));
const ADMIN = { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' };

/** Standards as config.yml defines them, plus a pinned workflow for tests. */
function std(overrides = {}) {
  return { ...getStandards(REPO_CONFIG), ...overrides };
}

const ok = (body) => ({ status: 200, body });
const err = (status, message) => ({ status, body: { message } });

const tagRulesets = () => [
  { id: 901, name: 'immutable', target: 'tag', enforcement: 'active', source_type: 'Repository',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'update' }], bypass_actors: [] },
  { id: 902, name: 'create', target: 'tag', enforcement: 'active', source_type: 'Repository',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'creation' }], bypass_actors: [ADMIN] }
];

/** A repo that meets every standard: the positive control. */
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
    rulesets: { status: 200, items: [managed, ...tagRulesets()] },
    workflows: ok([{ name: 'ci.yml', path: '.github/workflows/ci.yml' },
      { name: 'hostname-scan.yml', path: '.github/workflows/hostname-scan.yml' }])
  };
}

const drifted = (ev) => ev.findings.filter((f) => f.drift).map((f) => f.rule).sort();

describe('config.yml standards', () => {
  it('the shipped config.yml validates, standards included', () => {
    expect(validateConfig(REPO_CONFIG)).toEqual({ valid: true, errors: [] });
    expect(getStandards(REPO_CONFIG).enabled).toBe(true);
  });

  describe('negative controls: a config violating the floor is rejected', () => {
    it('enforce_admins false contradicts no_bypass', () => {
      const cfg = structuredClone(REPO_CONFIG);
      cfg.branch_protection.default.enforce_admins = false;
      expect(validateConfig(cfg).errors).toContain(
        'standards.no_bypass requires branch_protection.default.enforce_admins: true');
      cfg.branch_protection.default.enforce_admins = true; // restore by re-editing
      expect(validateConfig(cfg).valid).toBe(true);
    });

    it('signed commits off contradicts required_signatures', () => {
      const cfg = structuredClone(REPO_CONFIG);
      cfg.branch_protection.default.require_signed_commits = false;
      expect(validateConfig(cfg).valid).toBe(false);
      cfg.branch_protection.default.require_signed_commits = true;
      expect(validateConfig(cfg).valid).toBe(true);
    });

    it('rebase merges are rejected alongside required signatures', () => {
      const cfg = structuredClone(REPO_CONFIG);
      cfg.settings.merge.allow_rebase_merge = true;
      expect(validateConfig(cfg).valid).toBe(false);
    });

    it('a workflow pin must be a full commit sha', () => {
      const cfg = structuredClone(REPO_CONFIG);
      cfg.standards.required_workflows[0].pin = 'main';
      expect(validateConfig(cfg).errors.join()).toMatch(/40-hex/);
      cfg.standards.required_workflows[0].pin = 'a'.repeat(40);
      expect(validateConfig(cfg).valid).toBe(true);
    });

    it('rejects malformed blocks', () => {
      expect(validateStandards({ standards: 'yes' })).toEqual(['standards must be an object']);
      expect(validateStandards({ standards: { enabled: false, merge_queue: { repos: 'x' } } })).toEqual([]);
      const e = validateStandards({
        branch_protection: { default: { enforce_admins: true, require_signed_commits: true } },
        standards: { enabled: true, merge_queue: { repos: 'x' }, required_workflows: [{ name: 'x' }],
          repos: { a: { required_checks: 'build' } } }
      });
      expect(e).toEqual(expect.arrayContaining([
        'standards.merge_queue.repos must be an array',
        'standards.required_workflows[0] needs name, context, path and template',
        'standards.repos.a.required_checks must be an array'
      ]));
    });
  });
});

describe('evaluateRepo', () => {
  it('positive control: a compliant repo has no drift', () => {
    const ev = evaluateRepo(compliantSnapshot(), std());
    expect(ev.scope).toBe('enforced');
    expect(drifted(ev)).toEqual([]);
    expect(hasDrift(ev)).toBe(false);
  });

  it('negative control: breaking each standard shows drift; re-editing restores', () => {
    const snap = compliantSnapshot();
    // Checks stay binding through the bypass-free ruleset, so only no_bypass drifts.
    snap.protection.body.enforce_admins.enabled = false;
    expect(drifted(evaluateRepo(snap, std()))).toEqual(['no_bypass']);
    snap.protection.body.enforce_admins.enabled = true;

    snap.rulesets.items[0].bypass_actors = [ADMIN];
    const ev = evaluateRepo(snap, std());
    expect(drifted(ev)).toEqual(['no_bypass', 'required_checks']);
    expect(ev.findings.find((f) => f.rule === 'no_bypass').actual).toMatch(/RepositoryRole:5\/always/);
    snap.rulesets.items[0].bypass_actors = [];

    snap.protection.body.required_signatures.enabled = false;
    snap.branchRules.body = snap.branchRules.body.filter((r) => r.type !== 'required_signatures');
    expect(drifted(evaluateRepo(snap, std()))).toEqual(['required_signatures']);

    expect(hasDrift(evaluateRepo(compliantSnapshot(), std()))).toBe(false);
  });

  it('kiln shape: classic enforce_admins off + an inert ruleset = admin bypass, checks not binding', () => {
    const snap = compliantSnapshot('kiln');
    snap.protection.body.enforce_admins.enabled = false;
    snap.protection.body.required_pull_request_reviews = null;
    snap.rulesets.items = [{ id: 7, name: 'main', target: 'branch', enforcement: 'active',
      source_type: 'Repository', conditions: { ref_name: { include: [], exclude: [] } },
      rules: [{ type: 'pull_request' }], bypass_actors: [] }];
    snap.branchRules.body = [];
    const ev = evaluateRepo(snap, std());
    const byRule = Object.fromEntries(ev.findings.map((f) => [f.rule, f]));
    expect(byRule.no_bypass.drift).toBe(true);
    expect(byRule.no_bypass.note).toMatch(/inert ruleset.*"main"/);
    expect(byRule.required_checks.actual).toBe('1 required, 0 binding admins');
    expect(byRule.required_checks.fix).toBe('auto');
    expect(byRule.pull_request.drift).toBe(true);
    expect(byRule.tag_protection.drift).toBe(true);
  });

  it('no required checks anywhere is an owner decision, never an invented name', () => {
    const snap = compliantSnapshot('bare');
    snap.protection = err(404, 'Branch not protected');
    snap.branchRules.body = snap.branchRules.body.filter((r) => r.type !== 'required_status_checks');
    snap.workflows = ok([{ name: 'ci.yml', path: '.github/workflows/ci.yml' }]);
    const f = evaluateRepo(snap, std()).findings.find((x) => x.rule === 'required_checks');
    expect(f).toMatchObject({ drift: true, fix: 'owner' });
    expect(intendedContexts(deriveState(snap), std())).toEqual([]);
  });

  it('a per-repo override supplies the checks', () => {
    const snap = compliantSnapshot('bare');
    snap.protection = err(404, 'Branch not protected');
    snap.branchRules.body = [];
    const s = std({ repos: { bare: { required_checks: ['test', 'lint'] } } });
    const f = evaluateRepo(snap, s).findings.find((x) => x.rule === 'required_checks');
    expect(f).toMatchObject({ drift: true, fix: 'auto', intended: 'non-empty, binding (3)' });
  });

  it('queue repo: strict up-to-date is drift only once the queue is live', () => {
    const snap = compliantSnapshot('spar');
    snap.protection.body.required_status_checks.strict = true;
    const s = std({ merge_queue_repos: ['spar'] });
    let ev = evaluateRepo(snap, s);
    expect(drifted(ev)).toEqual(['merge_queue']);
    expect(ev.findings.find((f) => f.rule === 'update_branch' && f.intended.startsWith('strict')).note)
      .toMatch(/same change that turns the queue on/);

    snap.branchRules.body.push({ type: 'merge_queue', ruleset_id: 55, parameters: {} });
    ev = evaluateRepo(snap, s);
    expect(drifted(ev)).toEqual(['update_branch']);
    expect(ev.findings.find((f) => f.rule === 'update_branch' && f.drift).fix).toBe('auto');
  });

  it('allow_update_branch true is rule-3 drift', () => {
    const snap = compliantSnapshot();
    snap.repo.body.allow_update_branch = true;
    expect(drifted(evaluateRepo(snap, std()))).toEqual(['update_branch']);
  });

  it('varve shape: immutable tags without a creation restriction is partial', () => {
    const snap = compliantSnapshot('varve');
    snap.rulesets.items = snap.rulesets.items.filter((r) => r.id !== 902);
    const f = evaluateRepo(snap, std()).findings.find((x) => x.rule === 'tag_protection');
    expect(f).toMatchObject({ drift: true, note: 'missing: creation restricted' });
  });

  it('a tag ruleset that admins can bypass does not make tags immutable', () => {
    const snap = compliantSnapshot();
    snap.rulesets.items.find((r) => r.id === 901).bypass_actors = [ADMIN];
    expect(evaluateRepo(snap, std()).findings.find((x) => x.rule === 'tag_protection').note)
      .toMatch(/immutable/);
  });

  it('evaluate-mode or excluded tag rulesets do not count', () => {
    const snap = compliantSnapshot();
    snap.rulesets.items.find((r) => r.id === 901).enforcement = 'evaluate';
    snap.rulesets.items.find((r) => r.id === 902).conditions.ref_name.exclude = ['refs/tags/v**'];
    expect(evaluateRepo(snap, std()).findings.find((x) => x.rule === 'tag_protection').note)
      .toBe('missing: immutable (update+deletion, no bypass); creation restricted');
  });

  it('private repo on GitHub Free is unenforceable, but repo settings are still evaluated', () => {
    const snap = compliantSnapshot('smithy');
    const msg = 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)';
    snap.repo.body.private = true;
    snap.repo.body.allow_auto_merge = false;
    snap.protection = err(403, msg);
    snap.branchRules = err(403, msg);
    snap.rulesets = { status: 403, body: { message: msg }, items: [] };
    const ev = evaluateRepo(snap, std());
    expect(ev.scope).toBe('unenforceable');
    expect(ev.blocker).toMatch(/GitHub Free/);
    expect(drifted(ev)).toEqual(['auto_merge']);
    expect(ev.findings.find((f) => f.rule === 'auto_merge').fix).toBe('blocked');
  });

  it('a secondary-rate-limit 403 is NOT mistaken for the plan block', () => {
    const snap = compliantSnapshot();
    snap.protection = err(403, 'You have exceeded a secondary rate limit');
    expect(evaluateRepo(snap, std()).scope).toBe('enforced');
  });

  it('forks are out of scope by default; archived repos are skipped', () => {
    const fork = compliantSnapshot('wasmtime');
    fork.repo.body.fork = true;
    expect(evaluateRepo(fork, std())).toMatchObject({ scope: 'fork', findings: [] });
    expect(evaluateRepo(fork, std({ include_forks: true })).scope).toBe('enforced');
    const arch = compliantSnapshot('old');
    arch.repo.body.archived = true;
    expect(evaluateRepo(arch, std()).scope).toBe('archived');
  });

  it('hostname-scan: absent stub with no pin is blocked; with a pin it is auto', () => {
    const snap = compliantSnapshot();
    snap.workflows = ok([{ name: 'ci.yml', path: '.github/workflows/ci.yml' }]);
    snap.branchRules.body[4].parameters.required_status_checks = [{ context: 'build' }];
    const f1 = evaluateRepo(snap, std()).findings.find((x) => x.rule === 'hostname_scan');
    expect(f1).toMatchObject({ drift: true, fix: 'blocked' });
    const pinned = std({ required_workflows: [{ ...std().required_workflows[0], pin: 'b'.repeat(40) }] });
    expect(evaluateRepo(snap, pinned).findings.find((x) => x.rule === 'hostname_scan').fix).toBe('auto');
  });

  it('merge-method drift is reported against config, not a hardcoded rebase-only ideal', () => {
    const snap = compliantSnapshot();
    snap.repo.body.allow_rebase_merge = true;
    const f = evaluateRepo(snap, std()).findings.filter((x) => x.rule === 'merge_methods' && x.drift);
    expect(f).toHaveLength(1);
    expect(f[0].intended).toBe('allow_rebase_merge=false');
  });
});

describe('managed and tag rulesets', () => {
  it('managed ruleset carries existing contexts, binds admins, keeps strictness off a queue', () => {
    const st = deriveState(compliantSnapshot('r'));
    const rs = buildManagedRuleset(REPO_CONFIG.branch_protection.default, st, std());
    expect(rs.bypass_actors).toEqual([]);
    const checks = rs.rules.find((r) => r.type === 'required_status_checks').parameters;
    expect(checks.required_status_checks.map((c) => c.context).sort()).toEqual(['build', 'hostname-scan']);
    expect(checks.strict_required_status_checks_policy).toBe(false);
    expect(rs.rules.map((r) => r.type)).toContain('required_signatures');
  });

  it('tag rulesets: immutable has no bypass; create bypass is the admin allowlist', () => {
    expect(buildTagImmutableRuleset(std())).toMatchObject({ target: 'tag', bypass_actors: [] });
    expect(buildTagCreateRuleset(std()).bypass_actors).toEqual([ADMIN]);
    expect(buildTagCreateRuleset(std()).rules).toEqual([{ type: 'creation' }]);
  });

  it('renders the stub template with pin and branch', () => {
    expect(renderWorkflowTemplate('a@__TEMPER_PIN__ [__TEMPER_DEFAULT_BRANCH__]', { pin: 'c'.repeat(40), defaultBranch: 'master' }))
      .toBe(`a@${'c'.repeat(40)} [master]`);
  });
});

function recordingOctokit(existingRulesets = []) {
  const calls = [];
  return {
    calls,
    paginate: jest.fn().mockResolvedValue(existingRulesets),
    request: jest.fn().mockImplementation((route, params) => {
      calls.push([route, params]);
      if (route.startsWith('POST /repos/{owner}/{repo}/rulesets')) return Promise.resolve({ data: { id: 1 } });
      if (route.startsWith('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}')) {
        return Promise.resolve({ data: existingRulesets.find((r) => r.id === params.ruleset_id) });
      }
      if (route.startsWith('GET /repos/{owner}/{repo}/git/ref')) return Promise.resolve({ data: { object: { sha: 'x' } } });
      if (route === 'GET /repos/{owner}/{repo}') return Promise.resolve({ data: { default_branch: 'main' } });
      if (route.startsWith('GET /repos/{owner}/{repo}/contents')) return Promise.reject(Object.assign(new Error('nf'), { status: 404 }));
      return Promise.resolve({ status: 200, data: { number: 3 } });
    })
  };
}

describe('enforceStandards', () => {
  const bp = REPO_CONFIG.branch_protection.default;

  it('kiln shape: narrow legacy fixes, managed ruleset with carried contexts, tag rulesets; never PUT protection', async () => {
    const snap = compliantSnapshot('kiln');
    snap.protection.body.enforce_admins.enabled = false;
    snap.rulesets.items = [];
    snap.branchRules.body = [];
    const kit = recordingOctokit();
    const { actions } = await enforceStandards(kit, 'pulseengine', bp, snap, std(), {});
    const routes = kit.calls.map((c) => c[0]);
    expect(routes).toContain('POST /repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins');
    expect(routes).not.toContain('PUT /repos/{owner}/{repo}/branches/{branch}/protection');
    const created = kit.calls.filter((c) => c[0] === 'POST /repos/{owner}/{repo}/rulesets').map((c) => c[1]);
    expect(created.map((r) => r.name)).toEqual([
      'temper-default-branch-protection', 'temper-release-tags-immutable', 'temper-release-tags-create']);
    const checks = created[0].rules.find((r) => r.type === 'required_status_checks');
    expect(checks.parameters.required_status_checks).toEqual([{ context: 'build' }, { context: 'hostname-scan' }]);
    expect(actions).toEqual(expect.arrayContaining(['classic protection: enforce_admins on']));
  });

  it('strips bypass actors from a foreign repo ruleset, keeping its rules', async () => {
    const snap = compliantSnapshot('r');
    const foreign = { id: 300, name: 'their-ruleset', target: 'branch', enforcement: 'active', source_type: 'Repository',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'x' }] } }],
      bypass_actors: [ADMIN] };
    snap.rulesets.items.push(foreign);
    snap.branchRules.body.push({ type: 'required_status_checks', ruleset_id: 300, parameters: foreign.rules[0].parameters });
    const kit = recordingOctokit([snap.rulesets.items[0]]);
    await enforceStandards(kit, 'pulseengine', bp, snap, std(), {});
    const put = kit.calls.find((c) => c[0] === 'PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}' && c[1].ruleset_id === 300);
    expect(put[1]).toMatchObject({ bypass_actors: [], rules: foreign.rules, name: 'their-ruleset' });
    expect(kit.calls.some((c) => c[0].startsWith('PUT') && c[1].ruleset_id === 300 && c[1].bypass_actors.length)).toBe(false);
  });

  it('does not touch an org-sourced ruleset (reported for the owner instead)', async () => {
    const snap = compliantSnapshot('r');
    snap.rulesets.items.push({ id: 400, name: 'org', target: 'branch', enforcement: 'active', source_type: 'Organization',
      conditions: {}, rules: [{ type: 'deletion' }], bypass_actors: [ADMIN] });
    snap.branchRules.body.push({ type: 'deletion', ruleset_id: 400 });
    expect(evaluateRepo(snap, std()).findings.find((f) => f.rule === 'no_bypass').fix).toBe('owner');
    const kit = recordingOctokit([snap.rulesets.items[0]]);
    await enforceStandards(kit, 'pulseengine', bp, snap, std(), {});
    expect(kit.calls.some((c) => c[1]?.ruleset_id === 400 && c[0].startsWith('PUT'))).toBe(false);
  });

  it('switches classic strict off on a live queue repo via the narrow endpoint', async () => {
    const snap = compliantSnapshot('spar');
    snap.protection.body.required_status_checks.strict = true;
    snap.branchRules.body.push({ type: 'merge_queue', ruleset_id: 55 });
    const kit = recordingOctokit([snap.rulesets.items[0]]);
    await enforceStandards(kit, 'pulseengine', bp, snap, std({ merge_queue_repos: ['spar'] }), {});
    const patch = kit.calls.find((c) => c[0] === 'PATCH /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks');
    expect(patch[1]).toMatchObject({ strict: false });
  });

  it('opens the stub PR only when pinned, rendering the pin in', async () => {
    const snap = compliantSnapshot('r');
    snap.workflows = ok([]);
    const sha = 'd'.repeat(40);
    const pinned = std({ required_workflows: [{ ...std().required_workflows[0], pin: sha }] });
    const readTemplate = jest.fn().mockReturnValue('uses: x@__TEMPER_PIN__');
    const kit = recordingOctokit([snap.rulesets.items[0]]);
    const { actions } = await enforceStandards(kit, 'pulseengine', REPO_CONFIG.branch_protection.default, snap, pinned, { readTemplate });
    expect(actions).toContain('PR: add .github/workflows/hostname-scan.yml');
    const put = kit.calls.find((c) => c[0] === 'PUT /repos/{owner}/{repo}/contents/{path}');
    expect(Buffer.from(put[1].content, 'base64').toString()).toBe(`uses: x@${sha}`);

    const kit2 = recordingOctokit([snap.rulesets.items[0]]);
    await enforceStandards(kit2, 'pulseengine', REPO_CONFIG.branch_protection.default, snap, std(), { readTemplate });
    expect(kit2.calls.some((c) => c[0].startsWith('POST /repos/{owner}/{repo}/pulls'))).toBe(false);
  });

  it('does nothing on unenforceable or fork repos', async () => {
    const snap = compliantSnapshot('w');
    snap.repo.body.fork = true;
    const kit = recordingOctokit();
    expect((await enforceStandards(kit, 'o', bp, snap, std(), {})).actions).toEqual([]);
    expect(kit.calls).toEqual([]);
  });
});

describe('snapshots', () => {
  it('fetchSnapshot records statuses instead of throwing', async () => {
    const kit = {
      request: jest.fn().mockImplementation((route) => {
        if (route === 'GET /repos/{owner}/{repo}') return Promise.resolve({ status: 200, data: { default_branch: 'main' } });
        if (route.endsWith('/protection')) return Promise.reject(Object.assign(new Error('Branch not protected'), { status: 404 }));
        if (route.endsWith('/rulesets')) return Promise.resolve({ status: 200, data: [{ id: 1 }] });
        if (route.endsWith('{ruleset_id}')) return Promise.resolve({ status: 200, data: { id: 1, name: 'x', bypass_actors: [] } });
        return Promise.resolve({ status: 200, data: [] });
      })
    };
    const snap = await fetchSnapshot(kit, 'o', 'r');
    expect(snap.protection).toEqual({ status: 404, body: { message: 'Branch not protected' } });
    expect(snap.rulesets.items).toEqual([{ id: 1, name: 'x', bypass_actors: [] }]);
  });

  it('loadSnapshotDir reads a sweep cache and evaluates like the live snapshot', () => {
    const live = compliantSnapshot('fromdisk');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temper-snap-'));
    const repoDir = path.join(dir, 'fromdisk');
    fs.mkdirSync(repoDir);
    const w = (f, v) => fs.writeFileSync(path.join(repoDir, f), JSON.stringify(v));
    w('repo.json', live.repo);
    w('protection.json', live.protection);
    w('branch_rules.json', live.branchRules);
    w('rulesets_list.json', ok(live.rulesets.items.map((r) => ({ id: r.id, name: r.name }))));
    for (const r of live.rulesets.items) w(`ruleset_${r.id}.json`, ok(r));
    w('workflows.json', live.workflows);
    const fromDisk = loadSnapshotDir(repoDir);
    expect(evaluateRepo(fromDisk, std())).toEqual(evaluateRepo(live, std()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
