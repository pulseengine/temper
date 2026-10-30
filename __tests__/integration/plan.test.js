import fs from 'fs';
import os from 'os';
import path from 'path';
import { planOrg, auditSnapshots, renderPlan } from '../../src/plan.js';
import { createDryRunOctokit } from '../../src/dry-run.js';
import { _setConfigForTesting, getConfig } from '../../src/config.js';

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });

/** A read-only fake GitHub: one org with one bare repo and one fork. */
function fakeGitHub() {
  const repos = [
    { name: 'bare', full_name: 'o/bare', owner: { login: 'o' }, default_branch: 'main', fork: false, archived: false,
      visibility: 'public', private: false, allow_merge_commit: true, allow_squash_merge: true,
      allow_rebase_merge: false, allow_auto_merge: true, allow_update_branch: true },
    { name: 'up', full_name: 'o/up', owner: { login: 'o' }, default_branch: 'main', fork: true, archived: false,
      visibility: 'public' },
    { name: 'gone', full_name: 'o/gone', owner: { login: 'o' }, archived: true }
  ];
  return {
    request: jest.fn().mockImplementation(async (route, p) => {
      if (!route.startsWith('GET ')) throw new Error(`real octokit received a write: ${route}`);
      if (route === 'GET /orgs/{org}/repos') return { status: 200, data: p.page === 1 ? repos : [] };
      if (route === 'GET /repos/{owner}/{repo}') return { status: 200, data: repos.find((r) => r.name === p.repo) };
      if (route.endsWith('/rulesets') || route.endsWith('/labels') || route.endsWith('/pulls')) return { status: 200, data: [] };
      if (route.includes('/rules/branches/')) return { status: 200, data: [] };
      throw notFound();
    })
  };
}

describe('planOrg (dry-run)', () => {
  let saved;
  beforeAll(() => { saved = getConfig(); });
  afterAll(() => { _setConfigForTesting(saved); });

  it('plans the writes a sync would make, per repo, and sends none of them', async () => {
    const real = fakeGitHub();
    const dry = createDryRunOctokit(real, { minIntervalMs: 0 });
    const plan = await planOrg(real, 'o', { dryOctokit: dry });

    expect(plan.results.map((r) => r.repo)).toEqual(['bare', 'up']); // archived skipped, like sync
    for (const [route] of real.request.mock.calls) expect(route.startsWith('GET ')).toBe(true);

    const bare = plan.results.find((r) => r.repo === 'bare');
    expect(bare.drift).toBe(true);
    const urls = bare.writes.map((w) => `${w.method} ${w.url}`);
    expect(urls).toContain('PATCH /repos/o/bare');
    expect(bare.writes.find((w) => w.url === '/repos/o/bare' && w.method === 'PATCH').body.allow_update_branch).toBe(false);
    const rulesets = bare.writes.filter((w) => w.url === '/repos/o/bare/rulesets').map((w) => w.body.name);
    expect(rulesets).toEqual(['temper-default-branch-protection', 'temper-release-tags-immutable', 'temper-release-tags-create']);
    expect(bare.findings.find((f) => f.rule === 'required_checks')).toMatchObject({ drift: true, fix: 'owner' });

    const fork = plan.results.find((r) => r.repo === 'up');
    expect(fork.scope).toBe('fork');
    // Forks: merge settings / labels only, never a branch or tag ruleset.
    expect(fork.writes.filter((w) => w.url.includes('/rulesets') || w.url.includes('/protection'))).toEqual([]);

    const text = renderPlan(plan.results);
    expect(text).toMatch(/## bare — enforced, DRIFT/);
    expect(text).toMatch(/-> PATCH \/repos\/o\/bare/);
  });

  it('restricts to --repo names', async () => {
    const real = fakeGitHub();
    const plan = await planOrg(real, 'o', { dryOctokit: createDryRunOctokit(real, { minIntervalMs: 0 }), repos: ['up'] });
    expect(plan.results.map((r) => r.repo)).toEqual(['up']);
  });

  it('with standards disabled, the plan falls back to the legacy enforcement path', async () => {
    const cfg = structuredClone(saved);
    cfg.standards.enabled = false;
    _setConfigForTesting(cfg);
    try {
      const real = fakeGitHub();
      const plan = await planOrg(real, 'o', { dryOctokit: createDryRunOctokit(real, { minIntervalMs: 0 }), repos: ['bare'] });
      const names = plan.results[0].writes.filter((w) => w.url.endsWith('/rulesets')).map((w) => w.body.name);
      expect(names).toEqual(['temper-default-branch-protection']);
    } finally {
      _setConfigForTesting(saved);
    }
  });
});

describe('auditSnapshots (offline)', () => {
  it('evaluates every repo dir in a sweep cache', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'temper-audit-'));
    const d = path.join(root, 'solo');
    fs.mkdirSync(d);
    const w = (f, v) => fs.writeFileSync(path.join(d, f), JSON.stringify(v));
    w('repo.json', { status: 200, body: { name: 'solo', default_branch: 'main', allow_update_branch: false,
      allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: false, allow_auto_merge: true } });
    w('protection.json', { status: 404, body: { message: 'Branch not protected' } });
    w('branch_rules.json', { status: 200, body: [] });
    w('rulesets_list.json', { status: 200, body: [] });
    w('workflows.json', { status: 404, body: { message: 'Not Found' } });
    const out = auditSnapshots(root);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ repo: 'solo', scope: 'enforced', drift: true });
    expect(auditSnapshots(root, { repos: ['other'] })).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
