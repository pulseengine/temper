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
  buildTagRuleset,
  enforceStandards,
  fetchSnapshot,
  loadSnapshotDir,
  renderWorkflowTemplate
} from '../../src/standards.js';
import { validateConfig } from '../../src/schema.js';
import { rulesetsMatch } from '../../src/rulesets.js';
import { parseRequiredContexts } from '../../src/required-contexts.js';

const REPO_CONFIG = yaml.load(fs.readFileSync(path.join(__dirname, '..', '..', 'config.yml'), 'utf8'));
const ADMIN = { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' };

/** Standards as config.yml defines them, plus a pinned workflow for tests. */
function std(overrides = {}) {
  return { ...getStandards(REPO_CONFIG), ...overrides };
}

/** The standards with no accepted deviation: enforce_admins off is drift again. */
const strict = (overrides = {}) => std({ accepted_deviations: new Set(), ...overrides });

const ok = (body) => ({ status: 200, body });
const err = (status, message) => ({ status, body: { message } });

// The tag standard as pulseengine.eu applied it (2026-11-26): deletion and
// update blocked, creation open, the admin role may bypass.
const tagRulesets = () => [
  { id: 901, name: 'tag-v-protection', target: 'tag', enforcement: 'active', source_type: 'Repository',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'update' }], bypass_actors: [ADMIN] }
];

// temper's earlier two-ruleset shape (ordeal#186): stricter than the standard.
const oldTagRulesets = () => [
  { id: 911, name: 'temper-release-tags-immutable', target: 'tag', enforcement: 'active', source_type: 'Repository',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'update' }], bypass_actors: [] },
  { id: 912, name: 'temper-release-tags-create', target: 'tag', enforcement: 'active', source_type: 'Repository',
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
        required_status_checks: [{ context: 'build' }, { context: 'hostname-scan', integration_id: 15368 }] } }],
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
  it('.github/required-contexts.txt mirrors temper\'s own required checks', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'required-contexts.txt'), 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(parseRequiredContexts(text)).toEqual(REPO_CONFIG.standards.repos.temper.required_checks);
  });

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

    it('checks_app_id must be a positive integer', () => {
      const cfg = structuredClone(REPO_CONFIG);
      expect(cfg.standards.checks_app_id).toBe(15368);
      expect(validateConfig(cfg).valid).toBe(true);
      for (const bad of ['15368', 0, -1, 1.5]) {
        cfg.standards.checks_app_id = bad;
        expect(validateConfig(cfg).errors.join()).toMatch(/checks_app_id must be a positive integer/);
      }
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
    expect(drifted(evaluateRepo(snap, strict()))).toEqual(['no_bypass']);
    snap.protection.body.enforce_admins.enabled = true;

    snap.rulesets.items[0].bypass_actors = [ADMIN];
    const ev = evaluateRepo(snap, std());
    // A bypassable ruleset binds no one, so its check binding does not count either.
    expect(drifted(ev)).toEqual(['check_source', 'no_bypass', 'required_checks']);
    expect(ev.findings.find((f) => f.rule === 'no_bypass').actual).toMatch(/RepositoryRole:5\/always/);
    snap.rulesets.items[0].bypass_actors = [];

    snap.protection.body.required_signatures.enabled = false;
    snap.branchRules.body = snap.branchRules.body.filter((r) => r.type !== 'required_signatures');
    expect(drifted(evaluateRepo(snap, std()))).toEqual(['required_signatures']);

    expect(hasDrift(evaluateRepo(compliantSnapshot(), std()))).toBe(false);
  });

  it('classic enforce_admins off + an inert ruleset = admin bypass, checks not binding', () => {
    const snap = compliantSnapshot('r1');
    snap.protection.body.enforce_admins.enabled = false;
    snap.protection.body.required_pull_request_reviews = null;
    snap.rulesets.items = [{ id: 7, name: 'main', target: 'branch', enforcement: 'active',
      source_type: 'Repository', conditions: { ref_name: { include: [], exclude: [] } },
      rules: [{ type: 'pull_request' }], bypass_actors: [] }];
    snap.branchRules.body = [];
    const ev = evaluateRepo(snap, strict());
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
    const snap = compliantSnapshot('q');
    snap.protection.body.required_status_checks.strict = true;
    const s = std({ merge_queue_repos: ['q'] });
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

  const tagFinding = (snap, s = std()) => evaluateRepo(snap, s).findings.find((x) => x.rule === 'tag_protection');

  it('the standard ruleset meets the tag standard exactly (not stricter)', () => {
    const f = tagFinding(compliantSnapshot());
    expect(f).toMatchObject({ drift: false, note: '' });
    expect(f.stricter).toBeUndefined();
  });

  it('a ruleset missing update (force-move allowed) is drift', () => {
    const snap = compliantSnapshot('r2');
    snap.rulesets.items.find((r) => r.id === 901).rules = [{ type: 'deletion' }];
    expect(tagFinding(snap)).toMatchObject({ drift: true, note: 'a covering ruleset lacks a standard rule or has another bypass actor' });
  });

  it('a bypass actor outside the standard list is drift', () => {
    const snap = compliantSnapshot();
    snap.rulesets.items.find((r) => r.id === 901).bypass_actors = [ADMIN, { actor_id: 1, actor_type: 'OrganizationAdmin', bypass_mode: 'always' }];
    expect(tagFinding(snap).drift).toBe(true);
  });

  it('unknown bypass actors (not readable) do not meet the standard', () => {
    const snap = compliantSnapshot();
    snap.rulesets.items.find((r) => r.id === 901).bypass_actors = undefined;
    expect(tagFinding(snap).drift).toBe(true);
  });

  it("varve's deletion+update+required_signatures is stricter, not drift", () => {
    const snap = compliantSnapshot('varve');
    snap.rulesets.items.find((r) => r.id === 901).rules.push({ type: 'required_signatures' });
    expect(tagFinding(snap)).toMatchObject({ drift: false, stricter: true, note: 'stricter than the standard' });
  });

  it("temper's old two-ruleset shape (no bypass, creation restricted) is stricter, not drift", () => {
    const snap = compliantSnapshot();
    snap.rulesets.items = [...snap.rulesets.items.filter((r) => r.target !== 'tag'), ...oldTagRulesets()];
    expect(tagFinding(snap)).toMatchObject({ drift: false, stricter: true });
  });

  it('a creation-only ruleset beside the standard one makes it stricter', () => {
    const snap = compliantSnapshot();
    snap.rulesets.items.push(oldTagRulesets()[1]);
    expect(tagFinding(snap).stricter).toBe(true);
  });

  it('evaluate-mode or excluded tag rulesets do not count', () => {
    const snap = compliantSnapshot();
    snap.rulesets.items.find((r) => r.id === 901).enforcement = 'evaluate';
    expect(tagFinding(snap)).toMatchObject({ drift: true, note: 'no active tag ruleset covers it' });
    const snap2 = compliantSnapshot();
    snap2.rulesets.items.find((r) => r.id === 901).conditions.ref_name.exclude = ['refs/tags/v**'];
    expect(tagFinding(snap2).note).toBe('no active tag ruleset covers it');
  });

  it('accepted deviations: enforce_admins off and 0 approvals are reported, not drift', () => {
    const snap = compliantSnapshot();
    snap.protection.body.enforce_admins.enabled = false;
    const ev = evaluateRepo(snap, std());
    expect(drifted(ev)).toEqual([]);
    const byRule = Object.fromEntries(ev.findings.map((f) => [f.rule, f]));
    expect(byRule.enforce_admins).toMatchObject({ drift: false, accepted: true, actual: 'enforce_admins=false' });
    expect(byRule.required_reviews).toMatchObject({ drift: false, accepted: true, actual: 'required approving reviews = 0' });
    // with no deviation accepted, the same repo drifts and no accepted finding appears
    const evStrict = evaluateRepo(snap, strict());
    expect(drifted(evStrict)).toEqual(['no_bypass']);
    expect(evStrict.findings.some((f) => f.accepted)).toBe(false);
  });

  it('an accepted deviation does not hide a bypass actor on a branch ruleset', () => {
    const snap = compliantSnapshot();
    snap.protection.body.enforce_admins.enabled = false;
    snap.rulesets.items[0].bypass_actors = [ADMIN];
    expect(drifted(evaluateRepo(snap, std()))).toContain('no_bypass');
  });

  it('one required approval leaves nothing to accept for reviews', () => {
    const snap = compliantSnapshot();
    snap.protection.body.required_pull_request_reviews.required_approving_review_count = 1;
    expect(evaluateRepo(snap, std()).findings.some((f) => f.rule === 'required_reviews')).toBe(false);
    const viaRuleset = compliantSnapshot();
    viaRuleset.branchRules.body.find((r) => r.type === 'pull_request').parameters = { required_approving_review_count: 2 };
    expect(evaluateRepo(viaRuleset, std()).findings.some((f) => f.rule === 'required_reviews')).toBe(false);
  });

  it('private repo on GitHub Free is unenforceable, but repo settings are still evaluated', () => {
    const snap = compliantSnapshot('priv');
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
    const fork = compliantSnapshot('upstream-fork');
    fork.repo.body.fork = true;
    expect(evaluateRepo(fork, std())).toMatchObject({ scope: 'fork', findings: [] });
    expect(evaluateRepo(fork, std({ include_forks: true })).scope).toBe('enforced');
    const arch = compliantSnapshot('old');
    arch.repo.body.archived = true;
    expect(evaluateRepo(arch, std()).scope).toBe('archived');
  });

  it('report_only: findings are reported but nothing is enforced', async () => {
    const snap = compliantSnapshot('held');
    snap.protection.body.enforce_admins.enabled = false;
    const s = strict({ repos: { held: { report_only: 'bot pushes to main' } } });
    const ev = evaluateRepo(snap, s);
    expect(ev).toMatchObject({ scope: 'held', blocker: 'report-only: bot pushes to main' });
    expect(drifted(ev)).toContain('no_bypass');
    const kit = recordingOctokit();
    expect((await enforceStandards(kit, 'o', REPO_CONFIG.branch_protection.default, snap, s, {})).actions).toEqual([]);
    expect(kit.calls).toEqual([]);
    expect(validateStandards({ branch_protection: { default: { enforce_admins: true, require_signed_commits: true } },
      standards: { enabled: true, repos: { x: { report_only: '' } } } }))
      .toEqual(['standards.repos.x.report_only must be a non-empty reason string']);
  });

  it('hostname-scan: absent stub with no pin is blocked; with a pin it is auto', () => {
    const snap = compliantSnapshot();
    snap.workflows = ok([{ name: 'ci.yml', path: '.github/workflows/ci.yml' }]);
    snap.branchRules.body[4].parameters.required_status_checks = [{ context: 'build' }];
    const unpinned = std({ required_workflows: [{ ...std().required_workflows[0], pin: null }] });
    const f1 = evaluateRepo(snap, unpinned).findings.find((x) => x.rule === 'hostname_scan');
    expect(f1).toMatchObject({ drift: true, fix: 'blocked' });
    // config.yml pins it (a 40-hex temper main sha), so the stub is plannable
    expect(std().required_workflows[0].pin).toMatch(/^[0-9a-f]{40}$/);
    expect(evaluateRepo(snap, std()).findings.find((x) => x.rule === 'hostname_scan').fix).toBe('auto');
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

  it('tag ruleset: the standard rules, the admin bypass, named tag-v-protection', () => {
    expect(buildTagRuleset(std())).toEqual({
      name: 'tag-v-protection', target: 'tag', enforcement: 'active',
      conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
      rules: [{ type: 'deletion' }, { type: 'update' }], bypass_actors: [ADMIN]
    });
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

  it('classic bypass: narrow legacy fixes, managed ruleset with carried contexts, tag rulesets; never PUT protection', async () => {
    const snap = compliantSnapshot('r1');
    snap.protection.body.enforce_admins.enabled = false;
    snap.rulesets.items = [];
    snap.branchRules.body = [];
    const kit = recordingOctokit();
    const { actions } = await enforceStandards(kit, 'pulseengine', bp, snap, strict(), {});
    const routes = kit.calls.map((c) => c[0]);
    expect(routes).toContain('POST /repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins');
    expect(routes).not.toContain('PUT /repos/{owner}/{repo}/branches/{branch}/protection');
    const created = kit.calls.filter((c) => c[0] === 'POST /repos/{owner}/{repo}/rulesets').map((c) => c[1]);
    expect(created.map((r) => r.name)).toEqual([
      'temper-default-branch-protection', 'tag-v-protection']);
    const checks = created[0].rules.find((r) => r.type === 'required_status_checks');
    // hostname-scan is a required workflow temper names: bound to Actions;
    // build was carried over unbound and stays that way.
    expect(checks.parameters.required_status_checks).toEqual([{ context: 'build' }, { context: 'hostname-scan', integration_id: 15368 }]);
    expect(actions).toEqual(expect.arrayContaining(['classic protection: enforce_admins on']));
  });

  it('an accepted enforce_admins deviation is never written; a stricter tag shape is left alone', async () => {
    const snap = compliantSnapshot('r1');
    snap.protection.body.enforce_admins.enabled = false;
    snap.rulesets.items = [...snap.rulesets.items.filter((r) => r.target !== 'tag'), ...oldTagRulesets()];
    const kit = recordingOctokit([snap.rulesets.items[0]]);
    await enforceStandards(kit, 'pulseengine', bp, snap, std(), {});
    const routes = kit.calls.map((c) => c[0]);
    expect(routes).not.toContain('POST /repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins');
    expect(kit.calls.some((c) => c[1]?.target === 'tag')).toBe(false);
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
    const snap = compliantSnapshot('q');
    snap.protection.body.required_status_checks.strict = true;
    snap.branchRules.body.push({ type: 'merge_queue', ruleset_id: 55 });
    const kit = recordingOctokit([snap.rulesets.items[0]]);
    await enforceStandards(kit, 'pulseengine', bp, snap, std({ merge_queue_repos: ['q'] }), {});
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
    const unpinned = std({ required_workflows: [{ ...std().required_workflows[0], pin: null }] });
    await enforceStandards(kit2, 'pulseengine', REPO_CONFIG.branch_protection.default, snap, unpinned, { readTemplate });
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

  it('fetchSnapshot reads same-org sha-pinned reusable workflows at the pin, and nothing else', async () => {
    const sha = 'd'.repeat(40);
    const ci = `on: [pull_request]
jobs:
  required: { uses: o/shared/.github/workflows/required.yml@${sha} }
  tagged: { uses: o/shared/.github/workflows/required.yml@v2 }
  foreign: { uses: x/shared/.github/workflows/required.yml@${sha} }
`;
    const b64 = (t) => Buffer.from(t).toString('base64');
    const calls = [];
    const kit = {
      request: jest.fn().mockImplementation((route, p) => {
        if (route === 'GET /repos/{owner}/{repo}') return Promise.resolve({ status: 200, data: { default_branch: 'main' } });
        if (route.endsWith('{path}')) {
          calls.push(`${p.owner}/${p.repo}/${p.path}@${p.ref}`);
          if (p.path === '.github/workflows') return Promise.resolve({ status: 200, data: [{ name: 'ci.yml', path: '.github/workflows/ci.yml' }] });
          if (p.path === '.github/workflows/ci.yml' && p.repo === 'r') return Promise.resolve({ status: 200, data: { content: b64(ci) } });
          if (p.repo === 'shared') return Promise.resolve({ status: 200, data: { content: b64('jobs: {}') } });
          return Promise.reject(Object.assign(new Error('Not Found'), { status: 404 }));
        }
        return Promise.resolve({ status: 200, data: [] });
      })
    };
    const snap = await fetchSnapshot(kit, 'o', 'r');
    expect(calls.filter((c) => c.startsWith('o/shared') || c.startsWith('x/'))).toEqual([`o/shared/.github/workflows/required.yml@${sha}`]);
    expect(snap.remoteWorkflows).toEqual([
      { uses: `o/shared/.github/workflows/required.yml@${sha}`, text: 'jobs: {}' },
      { uses: 'o/shared/.github/workflows/required.yml@v2', reason: 'ref "v2" is not a full commit sha, so it is not read' },
      { uses: `x/shared/.github/workflows/required.yml@${sha}`, reason: 'another org (x) is not read' }
    ]);
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

// temper#100: a single required context ("required / verdict") is the whole
// gate, so a check temper names must come from GitHub Actions, not from any
// app that posts a status under that name.
describe('required checks are bound to the app that reports them', () => {
  const bound = (rs) => rs.rules.find((r) => r.type === 'required_status_checks').parameters.required_status_checks;

  it('every check from standards.repos.<repo>.required_checks is bound to Actions', () => {
    const s = std({ repos: { r: { required_checks: ['required / verdict', 'baseline / guard'] } } });
    const st = deriveState(compliantSnapshot('r'));
    const checks = bound(buildManagedRuleset(REPO_CONFIG.branch_protection.default, st, s));
    expect(checks.filter((c) => c.context !== 'hostname-scan')).toEqual([
      { context: 'required / verdict', integration_id: 15368 },
      { context: 'baseline / guard', integration_id: 15368 }
    ]);
    expect(checks.every((c) => c.integration_id === 15368)).toBe(true);
  });

  it('a carried-over context keeps its app (legacy app_id or ruleset integration_id)', () => {
    const snap = compliantSnapshot('r');
    snap.protection.body.required_status_checks.checks = [{ context: 'build', app_id: 4242 }];
    let checks = bound(buildManagedRuleset(REPO_CONFIG.branch_protection.default, deriveState(snap), std()));
    expect(checks).toContainEqual({ context: 'build', integration_id: 4242 });

    const snap2 = compliantSnapshot('r');
    snap2.rulesets.items[0].rules[4].parameters.required_status_checks[0] = { context: 'build', integration_id: 777 };
    snap2.branchRules.body[4].parameters.required_status_checks[0] = { context: 'build', integration_id: 777 };
    checks = bound(buildManagedRuleset(REPO_CONFIG.branch_protection.default, deriveState(snap2), std()));
    expect(checks).toContainEqual({ context: 'build', integration_id: 777 });
  });

  it('a named context bound to another app is rebound to Actions and reported until then', () => {
    const snap = compliantSnapshot('r');
    for (const rules of [snap.rulesets.items[0].rules, snap.branchRules.body]) {
      rules[4].parameters.required_status_checks[1] = { context: 'hostname-scan', integration_id: 4242 };
    }
    const checks = bound(buildManagedRuleset(REPO_CONFIG.branch_protection.default, deriveState(snap), std()));
    expect(checks).toContainEqual({ context: 'hostname-scan', integration_id: 15368 });
    expect(evaluateRepo(snap, std()).findings.find((f) => f.rule === 'check_source').drift).toBe(true);
  });

  it('a binding only in a bypassable ruleset does not count as bound', () => {
    const snap = compliantSnapshot('r');
    snap.rulesets.items[0].bypass_actors = [ADMIN];
    expect(evaluateRepo(snap, std()).findings.find((f) => f.rule === 'check_source').drift).toBe(true);
  });

  it('a context named like an Object.prototype key is not confused with a binding', () => {
    const snap = compliantSnapshot('r');
    for (const rules of [snap.rulesets.items[0].rules, snap.branchRules.body]) {
      rules[4].parameters.required_status_checks.push({ context: '__proto__' }, { context: 'constructor' });
    }
    const checks = bound(buildManagedRuleset(REPO_CONFIG.branch_protection.default, deriveState(snap), std()));
    expect(checks).toContainEqual({ context: '__proto__' });
    expect(checks).toContainEqual({ context: 'constructor' });
  });

  it('a context carried over unbound stays unbound (temper cannot know its app)', () => {
    const checks = bound(buildManagedRuleset(REPO_CONFIG.branch_protection.default, deriveState(compliantSnapshot('r')), std()));
    expect(checks).toContainEqual({ context: 'build' });
  });

  it('check_source: positive control clean; a named check accepted from any app is drift', () => {
    const clean = evaluateRepo(compliantSnapshot('r'), std()).findings.find((f) => f.rule === 'check_source');
    expect(clean.drift).toBe(false);
    const snap = compliantSnapshot('r');
    for (const rules of [snap.rulesets.items[0].rules, snap.branchRules.body]) {
      rules[4].parameters.required_status_checks[1] = { context: 'hostname-scan' };
    }
    const f = evaluateRepo(snap, std()).findings.find((x) => x.rule === 'check_source');
    expect(f).toMatchObject({ drift: true, fix: 'auto' });
    expect(f.actual).toContain('hostname-scan');
  });

  it('a bound ruleset matches what temper builds, so a sync does not re-PUT it', () => {
    const snap = compliantSnapshot('r');
    const desired = buildManagedRuleset(REPO_CONFIG.branch_protection.default, deriveState(snap), std());
    // The fixture's pull_request rule carries no parameters; give it the ones
    // temper sets, so only the status-check bindings are under test.
    const actual = structuredClone(snap.rulesets.items[0]);
    actual.rules[3].parameters = desired.rules.find((r) => r.type === 'pull_request').parameters;
    expect(rulesetsMatch(actual, desired)).toBe(true);
    // Negative control: the same ruleset without the binding is drift.
    actual.rules[4].parameters.required_status_checks[1] = { context: 'hostname-scan' };
    expect(rulesetsMatch(actual, desired)).toBe(false);
  });
});

describe('per-repo release-tag patterns (standards.repos.<repo>.tag_include)', () => {
  const bp = REPO_CONFIG.branch_protection.default;
  const falcon = (snap) => {
    for (const r of snap.rulesets.items.filter((x) => x.target === 'tag')) {
      r.conditions.ref_name.include = ['refs/tags/v*', 'refs/tags/falcon-v*'];
    }
    return snap;
  };

  it('config.yml holds relay to v* and falcon-v*, every other repo to v*', () => {
    expect(std().repos.relay.tag_include).toEqual(['refs/tags/v*', 'refs/tags/falcon-v*']);
    expect(evaluateRepo(compliantSnapshot('relay'), std()).tags.include).toEqual(['refs/tags/v*', 'refs/tags/falcon-v*']);
    expect(evaluateRepo(compliantSnapshot('sieve'), std()).tags.include).toEqual(['refs/tags/v*']);
  });

  it('v*-only rulesets leave relay drifting: no ruleset covers falcon-v1.0.0', () => {
    const f = evaluateRepo(compliantSnapshot('relay'), std()).findings.find((x) => x.rule === 'tag_protection');
    expect(f).toMatchObject({ drift: true, intended: 'refs/tags/v*,refs/tags/falcon-v*: rules deletion+update, bypass only RepositoryRole:5' });
    expect(f.note).toBe('no active tag ruleset covers it');
  });

  it('positive control: rulesets covering both patterns are ok for relay', () => {
    const f = evaluateRepo(falcon(compliantSnapshot('relay')), std()).findings.find((x) => x.rule === 'tag_protection');
    expect(f.drift).toBe(false);
  });

  it('every pattern must be covered: falcon-v*-only rulesets leave v* drifting', () => {
    const snap = compliantSnapshot('relay');
    for (const r of snap.rulesets.items.filter((x) => x.target === 'tag')) r.conditions.ref_name.include = ['refs/tags/falcon-v*'];
    const f = evaluateRepo(snap, std()).findings.find((x) => x.rule === 'tag_protection');
    expect(f.note).toBe('no active tag ruleset covers it');
  });

  it('enforcement builds relay\'s tag ruleset on both patterns', async () => {
    const snap = compliantSnapshot('relay');
    snap.rulesets.items = snap.rulesets.items.filter((r) => r.target !== 'tag');
    const kit = recordingOctokit();
    await enforceStandards(kit, 'pulseengine', bp, snap, std(), {});
    const tags = kit.calls.filter((c) => c[0] === 'POST /repos/{owner}/{repo}/rulesets' && c[1].target === 'tag').map((c) => c[1]);
    expect(tags.map((t) => t.name)).toEqual(['tag-v-protection']);
    for (const t of tags) expect(t.conditions.ref_name.include).toEqual(['refs/tags/v*', 'refs/tags/falcon-v*']);
  });

  it('the builders default to the org patterns', () => {
    expect(buildTagRuleset(std()).conditions.ref_name.include).toEqual(['refs/tags/v*']);
    expect(buildTagRuleset(std(), ['refs/tags/x*']).conditions.ref_name.include).toEqual(['refs/tags/x*']);
  });

  it('accepted_deviations and the tag standard are validated', () => {
    const v = (s) => validateStandards({ standards: { enabled: true, ...s } }).filter((e) => !e.includes('requires branch_protection'));
    expect(v({ accepted_deviations: ['enforce_admins', 'required_reviews'] })).toEqual([]);
    expect(v({ accepted_deviations: ['signatures'] })).toEqual(['standards.accepted_deviations must list only: enforce_admins, required_reviews']);
    expect(v({ tag_protection: { rules: ['deletion', 'rename'] } }).join()).toMatch(/tag_protection.rules/);
    expect(v({ tag_protection: { rules: [] } }).join()).toMatch(/tag_protection.rules/);
    expect(v({ tag_protection: { bypass_actors: [{}] } }).join()).toMatch(/bypass_actors/);
    expect(v({ tag_protection: { name: '' } }).join()).toMatch(/tag_protection.name/);
  });

  it('tag_include must be a non-empty list of refs/tags/ patterns', () => {
    const bad = (v) => validateStandards({ standards: { enabled: true, repos: { r: { tag_include: v } } } })
      .filter((e) => e.includes('tag_include'));
    expect(bad(['refs/tags/falcon-v*'])).toEqual([]);
    for (const v of [[], 'refs/tags/v*', ['falcon-v*'], [7]]) expect(bad(v).join()).toMatch(/tag_include/);
  });
});
