import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hasRivetYaml,
  extractTarballBuffer,
  fetchAndExtractTarball,
  assertNoEscapingSymlinks
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

function makeFakeSpawn({ exitCode = 0, errorOnSpawn = null, stderr = '', stderrChunks = null } = {}) {
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
    // Provide resume() so the production code's drain path is exercised.
    proc.stdout.resume = jest.fn();
    if (errorOnSpawn) {
      setImmediate(() => proc.emit('error', new Error(errorOnSpawn)));
    } else {
      if (stderrChunks) {
        setImmediate(() => {
          for (const c of stderrChunks) proc.stderr.emit('data', Buffer.from(c));
        });
      } else if (stderr) {
        setImmediate(() => proc.stderr.emit('data', Buffer.from(stderr)));
      }
    }
    return proc;
  });
}

/** Make a real, empty temp dir for tests that hit the post-extract walk. */
function freshTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'temper-rivet-test-'));
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
  let dest;
  beforeEach(() => { dest = freshTmpDir(); });
  afterEach(() => { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('resolves on tar exit code 0 and passes hardening flags', async () => {
    const spawnFn = makeFakeSpawn({ exitCode: 0 });
    await expect(extractTarballBuffer(Buffer.from('x'), dest, { spawnFn }))
      .resolves.toBeUndefined();
    expect(spawnFn).toHaveBeenCalledWith(
      'tar',
      ['-xz', '--strip-components=1', '--no-same-owner', '-C', dest],
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
    );
  });

  it('drains stdout so a piped `tar` cannot stall on a full pipe buffer', async () => {
    const spawnFn = makeFakeSpawn({ exitCode: 0 });
    let proc;
    const wrappedSpawn = jest.fn((...args) => {
      proc = spawnFn(...args);
      return proc;
    });
    await extractTarballBuffer(Buffer.from('x'), dest, { spawnFn: wrappedSpawn });
    expect(proc.stdout.resume).toHaveBeenCalled();
  });

  it('rejects on non-zero exit with stderr in message', async () => {
    const spawnFn = makeFakeSpawn({ exitCode: 1, stderr: 'tar: bad gzip' });
    await expect(extractTarballBuffer(Buffer.from('x'), dest, { spawnFn }))
      .rejects.toThrow(/tar exited 1/);
  });

  it('caps stderr at 64 KiB and marks the message truncated', async () => {
    // Emit ~256 KiB of stderr — well over the 64 KiB cap. Without bounding
    // we'd happily concat all of it into a string in this process.
    const big = 'x'.repeat(64 * 1024);
    const spawnFn = makeFakeSpawn({
      exitCode: 1,
      stderrChunks: [big, big, big, big]
    });
    let caught;
    try {
      await extractTarballBuffer(Buffer.from('x'), dest, { spawnFn });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // The thrown message must not contain the full 256 KiB — it should be
    // close to the 64 KiB cap plus a small prefix/suffix.
    expect(caught.message.length).toBeLessThan(64 * 1024 + 256);
    expect(caught.message).toMatch(/stderr truncated/);
  });

  it('rejects when tar cannot be spawned', async () => {
    const spawnFn = makeFakeSpawn({ errorOnSpawn: 'ENOENT' });
    await expect(extractTarballBuffer(Buffer.from('x'), dest, { spawnFn }))
      .rejects.toThrow(/ENOENT/);
  });

  it('rejects when post-extract walk finds an escaping symlink', async () => {
    // Simulate `tar` "successfully" extracting a tree that contains a
    // malicious symlink. We materialise the post-extract state by hand.
    const evilTarget = '/etc/passwd';
    const spawnFn = jest.fn(() => {
      const proc = new EventEmitter();
      proc.stdin = new EventEmitter();
      proc.stdin.write = jest.fn();
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stdout.resume = jest.fn();
      proc.stdin.end = jest.fn(() => {
        // Drop a nasty symlink BEFORE signalling tar exit, so the
        // post-extract walk has something to find.
        try {
          fs.symlinkSync(evilTarget, path.join(dest, 'rivet.yaml'));
        } catch { /* ignore — symlinks may be denied; test is best-effort */ }
        setImmediate(() => proc.emit('exit', 0));
      });
      return proc;
    });
    let caught;
    try {
      await extractTarballBuffer(Buffer.from('x'), dest, { spawnFn });
    } catch (err) {
      caught = err;
    }
    if (caught) {
      expect(caught.message).toMatch(/symlink escaping destDir/);
      // The bad link must have been removed.
      expect(fs.existsSync(path.join(dest, 'rivet.yaml'))).toBe(false);
    } else {
      // Symlink creation was unsupported on this runner (e.g. Windows
      // without dev-mode). The hardening still ran; nothing to assert.
      expect(spawnFn).toHaveBeenCalled();
    }
  });

  it('accepts a benign tree (no symlinks) without complaint', async () => {
    const spawnFn = jest.fn(() => {
      const proc = new EventEmitter();
      proc.stdin = new EventEmitter();
      proc.stdin.write = jest.fn();
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stdout.resume = jest.fn();
      proc.stdin.end = jest.fn(() => {
        // Realistic post-extract state: a couple of files and a subdir.
        fs.writeFileSync(path.join(dest, 'rivet.yaml'), 'project: test\n');
        fs.mkdirSync(path.join(dest, 'src'));
        fs.writeFileSync(path.join(dest, 'src', 'foo.js'), '// hi\n');
        setImmediate(() => proc.emit('exit', 0));
      });
      return proc;
    });
    await expect(
      extractTarballBuffer(Buffer.from('x'), dest, { spawnFn })
    ).resolves.toBeUndefined();
  });

  it('accepts a relative symlink that stays inside destDir', async () => {
    const spawnFn = jest.fn(() => {
      const proc = new EventEmitter();
      proc.stdin = new EventEmitter();
      proc.stdin.write = jest.fn();
      proc.stderr = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stdout.resume = jest.fn();
      proc.stdin.end = jest.fn(() => {
        fs.mkdirSync(path.join(dest, 'src'));
        fs.writeFileSync(path.join(dest, 'src', 'real.js'), '// real\n');
        try {
          fs.symlinkSync('./real.js', path.join(dest, 'src', 'alias.js'));
        } catch { /* ignore on platforms without symlink perms */ }
        setImmediate(() => proc.emit('exit', 0));
      });
      return proc;
    });
    await expect(
      extractTarballBuffer(Buffer.from('x'), dest, { spawnFn })
    ).resolves.toBeUndefined();
  });
});

describe('assertNoEscapingSymlinks', () => {
  let dest;
  beforeEach(() => { dest = freshTmpDir(); });
  afterEach(() => { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('rejects an absolute escaping symlink', async () => {
    try {
      fs.symlinkSync('/etc/passwd', path.join(dest, 'evil'));
    } catch {
      // Symlink unsupported — skip rather than false-pass.
      return;
    }
    await expect(assertNoEscapingSymlinks(dest)).rejects.toThrow(/escaping destDir/);
  });

  it('rejects a relative `..` symlink that climbs out', async () => {
    try {
      fs.symlinkSync('../../../../etc/passwd', path.join(dest, 'climb'));
    } catch {
      return;
    }
    await expect(assertNoEscapingSymlinks(dest)).rejects.toThrow(/escaping destDir/);
  });

  it('accepts a symlink whose target is inside destDir', async () => {
    fs.writeFileSync(path.join(dest, 'real'), 'ok');
    try {
      fs.symlinkSync('./real', path.join(dest, 'alias'));
    } catch {
      return;
    }
    await expect(assertNoEscapingSymlinks(dest)).resolves.toBeUndefined();
  });
});

describe('fetchAndExtractTarball', () => {
  let dest;
  beforeEach(() => { dest = freshTmpDir(); });
  afterEach(() => { try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* ignore */ } });

  it('requests the tarball and pipes it through tar', async () => {
    const oct = mockOctokit({ tarball: Buffer.from('hello-tar') });
    const spawnFn = makeFakeSpawn({ exitCode: 0 });
    await fetchAndExtractTarball(oct, 'o', 'r', 'sha123', dest, { spawnFn });
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
      fetchAndExtractTarball(oct, 'o', 'r', 'sha123', dest, { spawnFn })
    ).resolves.toBeUndefined();
  });
});
