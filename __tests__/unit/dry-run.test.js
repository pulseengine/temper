import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDryRunOctokit } from '../../src/dry-run.js';

function fakeReal(handler = () => ({ status: 200, data: { ok: true } })) {
  return { request: jest.fn().mockImplementation(async (route, params) => handler(route, params)) };
}

const noSleep = () => Promise.resolve();

describe('createDryRunOctokit', () => {
  it('never sends a write: PATCH/PUT/POST/DELETE are recorded, the real octokit is not called', async () => {
    const real = fakeReal();
    const dry = createDryRunOctokit(real, { minIntervalMs: 0, sleep: noSleep });
    await dry.request('PATCH /repos/{owner}/{repo}', { owner: 'o', repo: 'r', allow_update_branch: false });
    await dry.request('PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}', { owner: 'o', repo: 'r', ruleset_id: 9, bypass_actors: [] });
    await dry.request('POST /repos/{owner}/{repo}/rulesets', { owner: 'o', repo: 'r', name: 'x' });
    await dry.request('DELETE /repos/{owner}/{repo}/labels/{name}', { owner: 'o', repo: 'r', name: 'a b' });
    await dry.request('/repos/{owner}/{repo}', { method: 'patch', owner: 'o', repo: 'r' });
    expect(real.request).not.toHaveBeenCalled();
    expect(dry.writes.map((w) => `${w.method} ${w.url}`)).toEqual([
      'PATCH /repos/o/r',
      'PUT /repos/o/r/rulesets/9',
      'POST /repos/o/r/rulesets',
      'DELETE /repos/o/r/labels/a%20b',
      'PATCH /repos/o/r'
    ]);
    expect(dry.writes[0].body).toEqual({ allow_update_branch: false });
  });

  it('exposes no other octokit surface a write could slip through', () => {
    const dry = createDryRunOctokit(fakeReal());
    expect(dry.repos).toBeUndefined();
    expect(dry.rest).toBeUndefined();
    expect(dry.graphql).toBeUndefined();
  });

  it('refuses to paginate a write', async () => {
    const dry = createDryRunOctokit(fakeReal(), { minIntervalMs: 0 });
    await expect(dry.paginate('POST /repos/{owner}/{repo}/issues', {})).rejects.toThrow(/refusing/);
  });

  it('hashes file contents instead of printing them', async () => {
    const dry = createDryRunOctokit(fakeReal(), { minIntervalMs: 0 });
    await dry.request('PUT /repos/{owner}/{repo}/contents/{path}', {
      owner: 'o', repo: 'r', path: 'a.yml', content: Buffer.from('hello').toString('base64')
    });
    expect(dry.writes[0].body.content).toMatch(/^<5 bytes sha256:[0-9a-f]{12}>$/);
  });

  it('passes GETs through, throttled to the minimum interval', async () => {
    const real = fakeReal();
    const waits = [];
    const dry = createDryRunOctokit(real, { minIntervalMs: 1000, sleep: async (ms) => { waits.push(ms); } });
    await dry.request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' });
    await dry.request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'q' });
    expect(real.request).toHaveBeenCalledTimes(2);
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThan(900);
  });

  it('caches GETs (and their errors) on disk so a rerun sends nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temper-dry-'));
    const real = fakeReal((route) => {
      if (route.includes('protection')) throw Object.assign(new Error('Branch not protected'), { status: 404 });
      return { status: 200, data: { n: 1 } };
    });
    const first = createDryRunOctokit(real, { cacheDir: dir, minIntervalMs: 0 });
    await first.request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' });
    await expect(first.request('GET /x/protection', {})).rejects.toMatchObject({ status: 404 });
    const second = createDryRunOctokit(real, { cacheDir: dir, minIntervalMs: 0 });
    expect((await second.request('GET /repos/{owner}/{repo}', { owner: 'o', repo: 'r' })).data).toEqual({ n: 1 });
    await expect(second.request('GET /x/protection', {})).rejects.toMatchObject({ status: 404 });
    expect(real.request).toHaveBeenCalledTimes(2);
    expect(second.stats).toEqual({ live: 0, cached: 2 });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('backs off and retries on a secondary rate limit, but not on a plan 403', async () => {
    let n = 0;
    const real = fakeReal((route) => {
      if (route.includes('limited') && n++ === 0) {
        throw Object.assign(new Error('You have exceeded a secondary rate limit'), { status: 403 });
      }
      if (route.includes('plan')) throw Object.assign(new Error('Upgrade to GitHub Pro'), { status: 403 });
      return { status: 200, data: 'ok' };
    });
    const waits = [];
    const dry = createDryRunOctokit(real, { minIntervalMs: 0, sleep: async (ms) => { waits.push(ms); } });
    expect((await dry.request('GET /limited', {})).data).toBe('ok');
    expect(waits).toContain(60000);
    await expect(dry.request('GET /plan', {})).rejects.toMatchObject({ status: 403 });
  });

  it('paginates until a short page', async () => {
    const real = fakeReal((route, p) => ({ status: 200, data: p.page === 1 ? [1, 2] : [3] }));
    const dry = createDryRunOctokit(real, { minIntervalMs: 0 });
    expect(await dry.paginate('GET /orgs/{org}/repos', { org: 'o', per_page: 2 })).toEqual([1, 2, 3]);
  });

  it('drainWrites hands over and clears the recorded writes', async () => {
    const dry = createDryRunOctokit(fakeReal(), { minIntervalMs: 0 });
    await dry.request('POST /a', {});
    expect(dry.drainWrites()).toHaveLength(1);
    expect(dry.writes).toHaveLength(0);
  });
});
