import { EventEmitter } from 'node:events';
import {
  hasRivetYaml,
  extractTarballBuffer,
  fetchAndExtractTarball
} from '../../src/rivet-fetch.js';

function mockOctokit({ contents = null, contentsStatus = 200, tarball = null } = {}) {
  return {
    request: jest.fn().mockImplementation((route /*, params */) => {
      if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
        if (contentsStatus === 404) {
          const e = new Error('Not Found'); e.status = 404;
          return Promise.reject(e);
        }
        if (contentsStatus >= 500) {
          const e = new Error('Server'); e.status = contentsStatus;
          return Promise.reject(e);
        }
        return Promise.resolve({ status: 200, data: contents });
      }
      if (route === 'GET /repos/{owner}/{repo}/tarball/{ref}') {
        return Promise.resolve({ status: 200, data: tarball || Buffer.from('fake-tarball') });
      }
      return Promise.resolve({ status: 200, data: {} });
    })
  };
}

function makeFakeSpawn({ exitCode = 0, errorOnSpawn = null, stderr = '' } = {}) {
  return jest.fn(() => {
    const proc = new EventEmitter();
    proc.stdin = new EventEmitter();
    proc.stdin.end = jest.fn(() => {
      // Simulate async exit shortly after stdin closed.
      setImmediate(() => proc.emit('exit', exitCode));
    });
    proc.stdin.write = jest.fn();
    proc.stderr = new EventEmitter();
    proc.stdout = new EventEmitter();
    if (errorOnSpawn) {
      setImmediate(() => proc.emit('error', new Error(errorOnSpawn)));
    } else if (stderr) {
      setImmediate(() => proc.stderr.emit('data', Buffer.from(stderr)));
    }
    return proc;
  });
}

describe('hasRivetYaml', () => {
  it('returns true on 200 (file exists)', async () => {
    const oct = mockOctokit({ contents: { name: 'rivet.yaml' } });
    expect(await hasRivetYaml(oct, 'o', 'r', 'main')).toBe(true);
  });

  it('returns false on 404 (file absent)', async () => {
    const oct = mockOctokit({ contentsStatus: 404 });
    expect(await hasRivetYaml(oct, 'o', 'r', 'main')).toBe(false);
  });

  it('fails safe (returns false) on auth/server errors', async () => {
    const oct = mockOctokit({ contentsStatus: 503 });
    expect(await hasRivetYaml(oct, 'o', 'r', 'main')).toBe(false);
  });
});

describe('extractTarballBuffer', () => {
  it('resolves on tar exit code 0', async () => {
    const spawnFn = makeFakeSpawn({ exitCode: 0 });
    await expect(extractTarballBuffer(Buffer.from('x'), '/tmp/dest', { spawnFn }))
      .resolves.toBeUndefined();
    expect(spawnFn).toHaveBeenCalledWith(
      'tar',
      ['-xz', '--strip-components=1', '-C', '/tmp/dest'],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
  });

  it('rejects on non-zero exit with stderr in message', async () => {
    const spawnFn = makeFakeSpawn({ exitCode: 1, stderr: 'tar: bad gzip' });
    await expect(extractTarballBuffer(Buffer.from('x'), '/tmp/dest', { spawnFn }))
      .rejects.toThrow(/tar exited 1/);
  });

  it('rejects when tar cannot be spawned', async () => {
    const spawnFn = makeFakeSpawn({ errorOnSpawn: 'ENOENT' });
    await expect(extractTarballBuffer(Buffer.from('x'), '/tmp/dest', { spawnFn }))
      .rejects.toThrow(/ENOENT/);
  });
});

describe('fetchAndExtractTarball', () => {
  it('requests the tarball and pipes it through tar', async () => {
    const oct = mockOctokit({ tarball: Buffer.from('hello-tar') });
    const spawnFn = makeFakeSpawn({ exitCode: 0 });
    await fetchAndExtractTarball(oct, 'o', 'r', 'sha123', '/tmp/dest', { spawnFn });
    expect(oct.request).toHaveBeenCalledWith(
      'GET /repos/{owner}/{repo}/tarball/{ref}',
      { owner: 'o', repo: 'r', ref: 'sha123' }
    );
    expect(spawnFn).toHaveBeenCalledTimes(1);
  });

  it('handles ArrayBuffer responses (Octokit binary default)', async () => {
    const buf = new ArrayBuffer(8);
    new Uint8Array(buf).set([1, 2, 3, 4, 5, 6, 7, 8]);
    const oct = mockOctokit({ tarball: buf });
    const spawnFn = makeFakeSpawn({ exitCode: 0 });
    await expect(
      fetchAndExtractTarball(oct, 'o', 'r', 'sha123', '/tmp/dest', { spawnFn })
    ).resolves.toBeUndefined();
  });
});
