/**
 * Fetch a PR's working tree as a tarball and extract it locally so the rivet
 * CLI can run against a real on-disk repo. Used only for repos that ship
 * `rivet.yaml` — for everything else this is skipped before the tarball is
 * even requested.
 *
 * Tarballs are 50–100 MB on the rivet repo; the cost is real but bounded
 * (one fetch per AI review, only for instrumented repos). A future
 * optimisation could fetch only `rivet.yaml`, `artifacts/`, `schemas/`,
 * `.rivet/` via the Contents API, but that requires recursive traversal —
 * the tarball is the simpler primitive.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Cheap pre-check: is `rivet.yaml` at the root of this ref? Avoids the
 * tarball download entirely for the ~99% of pulseengine repos that don't
 * use rivet.
 */
export async function hasRivetYaml(octokit, owner, repo, ref) {
  try {
    await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path: 'rivet.yaml',
      ref
    });
    return true;
  } catch (err) {
    if (err.status === 404) return false;
    // Other errors (auth, rate limit) — treat as "skip oracle" to fail safely.
    return false;
  }
}

/**
 * Pipe a Buffer (the tarball bytes) through `tar -xz` into destDir. Strips
 * the leading "{owner}-{repo}-{sha}/" component so the resulting tree mirrors
 * the repo root.
 */
export function extractTarballBuffer(buffer, destDir, opts = {}) {
  const { spawnFn = spawn } = opts;
  return new Promise((resolve, reject) => {
    const tar = spawnFn('tar', ['-xz', '--strip-components=1', '-C', destDir], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stderr = '';
    tar.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    tar.on('error', reject);
    tar.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.trim()}`));
    });
    tar.stdin.on('error', reject);
    tar.stdin.end(buffer);
  });
}

/**
 * Fetch the GitHub tarball for a ref and extract it into destDir.
 *
 * @param {object} octokit
 * @param {string} owner
 * @param {string} repo
 * @param {string} ref
 * @param {string} destDir - already-created directory
 * @param {object} [opts]
 * @param {Function} [opts.spawnFn] - injected for tests
 */
export async function fetchAndExtractTarball(octokit, owner, repo, ref, destDir, opts = {}) {
  const response = await octokit.request('GET /repos/{owner}/{repo}/tarball/{ref}', {
    owner,
    repo,
    ref
  });
  const data = response.data;
  const buf = Buffer.isBuffer(data)
    ? data
    : data instanceof ArrayBuffer
      ? Buffer.from(data)
      : Buffer.from(data); // octokit usually returns ArrayBuffer for binary
  await extractTarballBuffer(buf, destDir, opts);
}

/**
 * Run `fn(repoPath)` against a freshly-extracted PR tree, then clean up.
 * Caller never sees the tempdir; cleanup happens even on error.
 */
export async function withTempRepoCheckout(octokit, owner, repo, ref, fn, opts = {}) {
  const dir = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), `temper-rivet-${owner}-${repo}-`.replace(/[^a-zA-Z0-9-_]/g, '_'))
  );
  try {
    await fetchAndExtractTarball(octokit, owner, repo, ref, dir, opts);
    return await fn(dir);
  } finally {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
      // Cleanup failure is non-fatal — tmpdirs get reaped by the OS eventually.
    }
  }
}
