import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import {
  readmeBlocksSettings, loadModule, evaluateReadme, readmeCheck, writeSyncPr, SYNC_BRANCH, VARIABLES_PATH
} from '../../src/readme-blocks.js';
import { syncReadmes, readmeContext } from '../../src/report-sweep.js';
import { validateConfig } from '../../src/schema.js';
import { validateReport } from '../../src/report.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const httpErr = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

/** Minimal octokit: files[ref][path] = text; records every write. */
function fakeOctokit({ files = {}, status = {}, refs = { main: 'base1' }, pulls = [] } = {}) {
  const calls = [];
  const request = async (route, p) => {
    calls.push([route, p]);
    if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
      const s = status[p.path];
      if (s) throw httpErr(s);
      const text = files[p.ref]?.[p.path];
      if (text === undefined) throw httpErr(404);
      return { data: { content: b64(text), sha: `sha-${p.ref}-${p.path}` } };
    }
    if (route === 'GET /repos/{owner}/{repo}/git/ref/{ref}') {
      return { data: { object: { sha: refs[p.ref.replace('heads/', '')] } } };
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls') return { data: pulls };
    if (route === 'PATCH /repos/{owner}/{repo}/git/refs/{ref}') {
      if (!refs[SYNC_BRANCH]) throw httpErr(422);
      refs[SYNC_BRANCH] = p.sha;
      files[SYNC_BRANCH] = { ...files.main };
      return { data: {} };
    }
    if (route === 'POST /repos/{owner}/{repo}/git/refs') {
      refs[SYNC_BRANCH] = p.sha;
      files[SYNC_BRANCH] = { ...files.main };
      return { data: {} };
    }
    if (route === 'PUT /repos/{owner}/{repo}/contents/{path}') {
      files[p.branch][p.path] = Buffer.from(p.content, 'base64').toString('utf8');
      return { data: {} };
    }
    if (route === 'POST /repos/{owner}/{repo}/pulls') return { data: { number: 7 } };
    throw new Error(`unexpected ${route}`);
  };
  return { request, calls };
}

describe('readme_blocks settings and schema', () => {
  test('off by default, and the shipped config keeps it off', () => {
    expect(readmeBlocksSettings({}).enabled).toBe(false);
    expect(readmeBlocksSettings({ readme_blocks: { enabled: 'true' } }).enabled).toBe(false);
    const s = readmeBlocksSettings({ readme_blocks: { enabled: true, module_path: '/m.wasm', module_sha256: 'AB'.repeat(32), repos: ['zwinger', 3] } });
    expect(s).toEqual({ enabled: true, modulePath: '/m.wasm', moduleSha256: 'ab'.repeat(32), repos: ['zwinger'] });
  });

  test('schema refuses bad keys, paths, hashes and repo names', () => {
    const errs = (rb) => validateConfig({ organization: 'o', readme_blocks: rb }).errors.filter((e) => e.startsWith('readme_blocks'));
    expect(errs({ enabled: false, repos: [] })).toEqual([]);
    expect(errs({ enabled: true, module_path: '/a.wasm', module_sha256: 'a'.repeat(64), repos: ['zwinger'] })).toEqual([]);
    expect(errs({ enabled: 'yes' })).toContain('readme_blocks.enabled must be a boolean');
    expect(errs({ module_path: 'rel.wasm' })).toContain('readme_blocks.module_path must be an absolute path');
    expect(errs({ module_sha256: 'abc' })).toContain('readme_blocks.module_sha256 must be 64 hex characters');
    expect(errs({ repos: ['a/b'] })).toContain('readme_blocks.repos must be a list of repo names');
    expect(errs({ path: '/x' })).toContain('readme_blocks.path is not a known key');
    expect(errs({ enabled: true })).toContain(
      'readme_blocks.module_path and readme_blocks.module_sha256 are required when readme_blocks.enabled is true');
    expect(errs([])).toEqual(['readme_blocks must be an object']);
  });
});

describe('loadModule refuses before compiling', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-load-'));
  const file = path.join(dir, 'm.wasm');
  fs.writeFileSync(file, Buffer.from('not wasm'));
  const sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  test('missing settings', () => {
    expect(() => loadModule({ modulePath: '', moduleSha256: sha })).toThrow(/required/);
    expect(() => loadModule({ modulePath: file, moduleSha256: 'x' })).toThrow(/required/);
  });
  test('sha256 mismatch names both hashes', () => {
    expect(() => loadModule({ modulePath: file, moduleSha256: '0'.repeat(64) })).toThrow(`module sha256 ${sha} is not the configured ${'0'.repeat(64)}`);
  });
  test('a matching hash over a non-module still fails to compile', () => {
    expect(() => loadModule({ modulePath: file, moduleSha256: sha })).toThrow(WebAssembly.CompileError);
  });
  test('readmeContext logs and returns null when the module is refused, null when off', () => {
    expect(readmeContext({ readme_blocks: { enabled: false } })).toBeNull();
    expect(readmeContext({ readme_blocks: { enabled: true, module_path: file, module_sha256: '0'.repeat(64) } })).toBeNull();
    const ctx = readmeContext({ readme_blocks: { enabled: true, module_path: file, module_sha256: sha, repos: ['zwinger'] } }, () => 'MOD');
    expect(ctx).toMatchObject({ mod: 'MOD', syncs: [], repos: ['zwinger'] });
  });
});

describe('evaluateReadme maps inputs and the module report to a code', () => {
  const vars = 'format: 1\n';
  const main = { [VARIABLES_PATH]: vars, 'README.md': 'old\n' };
  const run = (octokit, check) => evaluateReadme(octokit, 'MOD', 'pulseengine', 'zwinger', 'main', '/t', check);

  test('no variables file or no README is not_applicable, and the module is not run', async () => {
    const never = () => { throw new Error('ran'); };
    expect((await run(fakeOctokit({ files: { main: {} } }), never)).code).toBe('not_applicable');
    expect((await run(fakeOctokit({ files: { main: { [VARIABLES_PATH]: vars } } }), never)).code).toBe('not_applicable');
  });
  test('read failures are undecided', async () => {
    expect((await run(fakeOctokit({ files: { main }, status: { [VARIABLES_PATH]: 403 } }))).code).toBe('error_permission');
    expect((await run(fakeOctokit({ files: { main }, status: { 'README.md': 502 } }))).code).toBe('error_api');
  });
  test('module failure is unknown', async () => {
    const r = await run(fakeOctokit({ files: { main } }), () => { throw new Error('module exit 1'); });
    expect(r).toEqual({ code: 'unknown', reason: 'module exit 1' });
  });
  test('drift carries the synced README and its blob sha; ok carries none', async () => {
    const seen = [];
    const drift = (mod, input, t) => { seen.push([mod, input, t]); return { interface: 1, code: 'divergent_undeclared', reason: 'licence drifted', readme: 'new\n' }; };
    const r = await run(fakeOctokit({ files: { main } }), drift);
    expect(seen).toEqual([['MOD', { variables: vars, readme: 'old\n' }, '/t']]);
    expect(r).toEqual({ code: 'divergent_undeclared', reason: 'licence drifted', readme: 'new\n', readmeSha: 'sha-main-README.md' });
    const ok = await run(fakeOctokit({ files: { main } }), () => ({ interface: 1, code: 'ok', reason: '' }));
    expect(ok).toEqual({ code: 'ok', reason: '' });
  });
});

describe('readmeCheck fits the warte contract', () => {
  test.each([
    ['ok', true], ['not_applicable', true], ['divergent_undeclared', false],
    ['unknown', null], ['error_api', null], ['error_permission', null]
  ])('%s -> ok=%s, severity low', (code, ok) => {
    expect(readmeCheck(code)).toEqual({ id: 'readme.shared_blocks', ok, severity: 'low', code });
  });
  test('a report carrying the check validates', () => {
    const report = {
      schema: 'temper-report.v1', generated_at: '2026-11-27T00:00:00Z',
      temper: { version: '1.0.0', commit: 'a'.repeat(40), config_sha256: 'b'.repeat(64) },
      org: 'pulseengine',
      source: { trigger: 'sweep', last_sweep_at: null, api: { calls_last_hour: 0, remaining: 1, limit: 1, reset_at: '2026-11-27T00:00:00Z' } },
      summary: { repos: 1, compliant: 0, noncompliant: 1, unknown: 0 },
      repos: [{ name: 'zwinger', checked_at: '2026-11-27T00:00:00Z', default_branch: 'main', checks: [readmeCheck('divergent_undeclared')] }],
      org_checks: [],
      reviews: { window_days: 7, posted: 0, suppressed_no_findings: 0, findings: 0, dropped_unquoted: 0, rivet_oracle_runs: 0, errors: 0 },
      tasks: { pending: 0, in_progress: 0, failed: 0, oldest_pending_age_s: 0, stale_in_progress: 0 }
    };
    expect(validateReport(report)).toBeNull();
  });
});

describe('writeSyncPr', () => {
  const routes = (o) => o.calls.map(([r]) => r);

  test('first sync creates the branch, commits README.md only, opens a PR, never arms auto-merge', async () => {
    const o = fakeOctokit({ files: { main: { 'README.md': 'old\n' } } });
    expect(await writeSyncPr(o, 'pulseengine', 'zwinger', 'main', 'new\n')).toEqual({ action: 'opened', number: 7 });
    const put = o.calls.find(([r]) => r.startsWith('PUT'))[1];
    expect(put).toMatchObject({ path: 'README.md', branch: SYNC_BRANCH, sha: `sha-${SYNC_BRANCH}-README.md` });
    expect(Buffer.from(put.content, 'base64').toString('utf8')).toBe('new\n');
    const pr = o.calls.find(([r]) => r === 'POST /repos/{owner}/{repo}/pulls')[1];
    expect(pr).toMatchObject({ head: SYNC_BRANCH, base: 'main' });
    expect(routes(o).filter((r) => /merge|graphql/i.test(r))).toEqual([]);
    expect(routes(o)).toContain('POST /repos/{owner}/{repo}/git/refs');
  });

  test('an open PR is updated in place: branch reset to main, no second PR', async () => {
    const o = fakeOctokit({
      files: { main: { 'README.md': 'old\n' }, [SYNC_BRANCH]: { 'README.md': 'stale\n' } },
      refs: { main: 'base2', [SYNC_BRANCH]: 'old-head' },
      pulls: [{ number: 5, base: { sha: 'base1' } }]
    });
    expect(await writeSyncPr(o, 'pulseengine', 'zwinger', 'main', 'new\n')).toEqual({ action: 'updated', number: 5 });
    expect(o.calls.find(([r]) => r.startsWith('PATCH'))[1]).toMatchObject({ sha: 'base2', force: true });
    expect(routes(o)).not.toContain('POST /repos/{owner}/{repo}/pulls');
  });

  test('an open PR already carrying the README on the current base is left alone', async () => {
    const o = fakeOctokit({
      files: { main: { 'README.md': 'old\n' }, [SYNC_BRANCH]: { 'README.md': 'new\n' } },
      refs: { main: 'base1', [SYNC_BRANCH]: 'h' },
      pulls: [{ number: 5, base: { sha: 'base1' } }]
    });
    expect(await writeSyncPr(o, 'pulseengine', 'zwinger', 'main', 'new\n')).toEqual({ action: 'unchanged', number: 5 });
    expect(routes(o).filter((r) => !r.startsWith('GET'))).toEqual([]);
  });

  test('syncReadmes writes only for listed repos and survives a failure', async () => {
    const o = fakeOctokit({ files: { main: { 'README.md': 'old\n' } } });
    const bad = { request: async () => { throw httpErr(500); } };
    const syncs = [{ repo: 'zwinger', branch: 'main', readme: 'new\n' }, { repo: 'spar', branch: 'main', readme: 'x\n' }];
    expect(await syncReadmes(o, 'pulseengine', syncs, ['zwinger'])).toEqual([{ repo: 'zwinger', action: 'opened', number: 7 }]);
    expect(await syncReadmes(bad, 'pulseengine', syncs, ['zwinger'])).toEqual([{ repo: 'zwinger', action: 'failed' }]);
    expect(await syncReadmes(o, 'pulseengine', syncs, [])).toEqual([]);
  });
});
