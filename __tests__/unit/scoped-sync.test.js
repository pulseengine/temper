import { createDryRunOctokit } from '../../src/dry-run.js';
import { writeKind, parseKinds, scopePlan, scopedSync, renderScoped, WRITE_KINDS } from '../../src/scoped-sync.js';

const noSleep = () => Promise.resolve();

// Record, through the real dry-run recorder, the writes configureRepository
// makes for one repo: one of every kind, plus a configuration-PR write.
async function recordedWrites(repo) {
  const dry = createDryRunOctokit({ request: jest.fn() }, { minIntervalMs: 0, sleep: noSleep });
  const o = { owner: 'pulseengine', repo };
  await dry.request('PATCH /repos/{owner}/{repo}', { ...o, allow_rebase_merge: false, allow_auto_merge: true });
  await dry.request('POST /repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins', { ...o, branch: 'main' });
  await dry.request('POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures', { ...o, branch: 'main' });
  await dry.request('POST /repos/{owner}/{repo}/rulesets', { ...o, name: 'temper-default-branch-protection', target: 'branch', rules: [] });
  await dry.request('PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}', { ...o, ruleset_id: 77, name: 'old', target: 'branch', rules: [] });
  await dry.request('POST /repos/{owner}/{repo}/rulesets', { ...o, name: 'temper-release-tags-immutable', target: 'tag', rules: [{ type: 'update' }] });
  await dry.request('POST /repos/{owner}/{repo}/rulesets', { ...o, name: 'temper-release-tags-create', target: 'tag', rules: [{ type: 'creation' }] });
  await dry.request('POST /repos/{owner}/{repo}/labels', { ...o, name: 'perennial', color: 'c5def5' });
  await dry.request('PATCH /repos/{owner}/{repo}/labels/{name}', { ...o, name: 'automation', color: '0e8a16' });
  await dry.request('PUT /repos/{owner}/{repo}/contents/{path}', { ...o, path: '.github/workflows/x.yml', content: Buffer.from('x').toString('base64') });
  await dry.request('POST /repos/{owner}/{repo}/pulls', { ...o, head: 'bot/x', base: 'main', title: 't' });
  return dry.drainWrites();
}

async function stubPlanner(names, scopes = {}) {
  const results = [];
  for (const n of names) results.push({ repo: n, scope: scopes[n] || 'enforced', blocker: null, writes: await recordedWrites(n) });
  const planner = jest.fn(async (_kit, _org, { repos }) => ({
    results: results.filter((r) => !repos || repos.includes(r.repo))
  }));
  return planner;
}

describe('writeKind', () => {
  it('classifies every recorded write; content and PR writes are not replayable', async () => {
    const kinds = (await recordedWrites('r')).map(writeKind);
    expect(kinds).toEqual([
      'merge', 'enforce_admins', 'signatures', 'branch_ruleset', 'branch_ruleset',
      'tag_rulesets', 'tag_rulesets', 'labels', 'labels', 'other', 'other'
    ]);
  });

  it('a ruleset without a target is not replayable', () => {
    expect(writeKind({ method: 'POST', route: 'POST /repos/{owner}/{repo}/rulesets', body: {} })).toBe('other');
  });
});

describe('parseKinds', () => {
  it('defaults to every replayable kind and rejects unknown ones', () => {
    expect(parseKinds(null)).toEqual([...WRITE_KINDS]);
    expect(parseKinds('tag_rulesets')).toEqual(['tag_rulesets']);
    expect(() => parseKinds('tag_v')).toThrow(/--only takes/);
    expect(() => parseKinds('other')).toThrow(/--only takes/);
    expect(() => parseKinds('')).toThrow(/--only takes/);
  });
});

describe('scopedSync', () => {
  it('negative control: --repo plant --only tag_rulesets touches no other repo and no other rule', async () => {
    const planner = await stubPlanner(['plant', 'sieve', 'kiln']);
    const real = { request: jest.fn().mockResolvedValue({ status: 201, data: {} }) };
    const res = await scopedSync(real, 'pulseengine', { repos: ['plant'], only: 'tag_rulesets', planner });

    expect(planner.mock.calls[0][2].repos).toEqual(['plant']);
    expect(real.request.mock.calls.map(([route, p]) => `${route} ${p.owner}/${p.repo} ${p.name}`)).toEqual([
      'POST /repos/{owner}/{repo}/rulesets pulseengine/plant temper-release-tags-immutable',
      'POST /repos/{owner}/{repo}/rulesets pulseengine/plant temper-release-tags-create'
    ]);
    expect(res.applied).toHaveLength(2);
    expect(res.failed).toEqual([]);
  });

  it('replays each call as recorded: route template, path params and body', async () => {
    const planner = await stubPlanner(['sieve']);
    const real = { request: jest.fn().mockResolvedValue({ status: 200, data: {} }) };
    await scopedSync(real, 'pulseengine', { repos: ['sieve'], only: 'branch_ruleset,merge', planner });
    expect(real.request.mock.calls).toEqual([
      ['PATCH /repos/{owner}/{repo}', { owner: 'pulseengine', repo: 'sieve', allow_rebase_merge: false, allow_auto_merge: true }],
      ['POST /repos/{owner}/{repo}/rulesets', { owner: 'pulseengine', repo: 'sieve', name: 'temper-default-branch-protection', target: 'branch', rules: [] }],
      ['PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}', { owner: 'pulseengine', repo: 'sieve', ruleset_id: 77, name: 'old', target: 'branch', rules: [] }]
    ]);
  });

  it('never replays configuration-PR or content writes, even with every kind selected', async () => {
    const planner = await stubPlanner(['plant']);
    const real = { request: jest.fn().mockResolvedValue({ status: 200, data: {} }) };
    const res = await scopedSync(real, 'pulseengine', { repos: ['plant'], planner });
    const routes = real.request.mock.calls.map(([r]) => r);
    expect(routes.some((r) => /contents|pulls/.test(r))).toBe(false);
    expect(res.scoped[0].skipped.map((s) => s.kind)).toEqual(['other', 'other']);
  });

  it('dry run sends nothing and renders exactly the scoped writes', async () => {
    const planner = await stubPlanner(['plant', 'sieve']);
    const real = { request: jest.fn() };
    const res = await scopedSync(real, 'pulseengine', { repos: ['plant', 'sieve'], only: 'enforce_admins', dryRun: true, planner });
    expect(real.request).not.toHaveBeenCalled();
    const text = renderScoped(res);
    expect(text.match(/-> \[/g)).toHaveLength(2);
    expect(text).toContain('-> [enforce_admins] POST /repos/pulseengine/plant/branches/main/protection/enforce_admins');
    expect(text).toContain('-> [enforce_admins] POST /repos/pulseengine/sieve/branches/main/protection/enforce_admins');
  });

  it('does not write a repo whose scope is not enforced (held, fork, unenforceable)', async () => {
    const planner = await stubPlanner(['pulseengine-layers', 'zephyr'], { 'pulseengine-layers': 'held', zephyr: 'fork' });
    const real = { request: jest.fn() };
    const res = await scopedSync(real, 'pulseengine', { repos: ['pulseengine-layers', 'zephyr'], planner });
    expect(real.request).not.toHaveBeenCalled();
    expect(renderScoped(res)).toMatch(/pulseengine-layers: .*not applied: scope held/);
  });

  it('stops a repo at its first failed write and reports it', async () => {
    const planner = await stubPlanner(['plant', 'sieve']);
    const real = {
      request: jest.fn(async (route, p) => {
        if (p.repo === 'plant' && route.includes('enforce_admins')) throw new Error('403');
        return { status: 200, data: {} };
      })
    };
    const res = await scopedSync(real, 'pulseengine', { repos: ['plant', 'sieve'], only: 'merge,enforce_admins,signatures', planner });
    expect(res.failed).toEqual([expect.objectContaining({ repo: 'plant', kind: 'enforce_admins', error: '403' })]);
    expect(res.applied.filter((a) => a.repo === 'plant').map((a) => a.kind)).toEqual(['merge']);
    expect(res.applied.filter((a) => a.repo === 'sieve').map((a) => a.kind)).toEqual(['merge', 'enforce_admins', 'signatures']);
  });

  it('needs --repo, reports names that are not sync targets, and "*" plans every target', async () => {
    const planner = await stubPlanner(['plant']);
    await expect(scopedSync({ request: jest.fn() }, 'o', { repos: [], planner })).rejects.toThrow(/needs --repo/);
    const res = await scopedSync({ request: jest.fn() }, 'o', { repos: ['plant', 'nope'], dryRun: true, planner });
    expect(res.missing).toEqual(['nope']);
    await scopedSync({ request: jest.fn() }, 'o', { repos: ['*'], dryRun: true, planner });
    expect(planner.mock.calls.at(-1)[2].repos).toBeNull();
  });
});

describe('scopePlan', () => {
  it('keeps each write once, either in scope or skipped', async () => {
    const writes = await recordedWrites('r');
    const [s] = scopePlan([{ repo: 'r', scope: 'enforced', writes }], ['labels']);
    expect(s.apply.length + s.skipped.length).toBe(writes.length);
    expect(s.apply.map((w) => w.kind)).toEqual(['labels', 'labels']);
  });
});
