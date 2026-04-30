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

/** Cap stderr capture from `tar` to avoid OOM on pathological output. */
const TAR_STDERR_CAP_BYTES = 64 * 1024;

/**
 * Pipe a Buffer (the tarball bytes) through `tar -xz` into destDir. Strips
 * the leading "{owner}-{repo}-{sha}/" component so the resulting tree mirrors
 * the repo root.
 *
 * Hardening (Bug #15, wave-1 Security auditor):
 *   - `--no-same-owner`: ignore archive uid/gid (we run single-user anyway).
 *   - `-P` is *not* passed: tar must strip leading `/` and reject `..`
 *     components. (Default behaviour on GNU tar and bsdtar; explicit because
 *     a hostile patch could otherwise re-enable absolute paths.)
 *   - Post-extract walk: every symlink whose resolved target escapes
 *     `destDir` is removed, and the extraction is rejected. A subsequent
 *     `runRivetOracle` therefore cannot read `rivet.yaml` (or anything else)
 *     from outside the sandbox.
 *   - Stderr buffer is capped at 64 KiB so a malicious tarball cannot
 *     trigger unbounded memory growth in this process.
 *   - `tar.stdout` is drained — it's piped but the parent never reads from
 *     it; without a consumer the pipe buffer can fill and stall `tar`.
 */
export function extractTarballBuffer(buffer, destDir, opts = {}) {
  const { spawnFn = spawn, postExtractCheck = assertNoEscapingSymlinks } = opts;
  return new Promise((resolve, reject) => {
    const tar = spawnFn(
      'tar',
      ['-xz', '--strip-components=1', '--no-same-owner', '-C', destDir],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stderr = '';
    let stderrTruncated = false;
    tar.stderr.on('data', (chunk) => {
      if (stderr.length >= TAR_STDERR_CAP_BYTES) {
        stderrTruncated = true;
        return;
      }
      const remaining = TAR_STDERR_CAP_BYTES - stderr.length;
      const piece = chunk.toString();
      if (piece.length > remaining) {
        stderr += piece.slice(0, remaining);
        stderrTruncated = true;
      } else {
        stderr += piece;
      }
    });
    // Drain stdout so the pipe buffer never fills and stalls `tar`.
    if (tar.stdout && typeof tar.stdout.resume === 'function') {
      tar.stdout.resume();
    } else if (tar.stdout && typeof tar.stdout.on === 'function') {
      tar.stdout.on('data', () => {});
    }
    tar.on('error', reject);
    tar.on('exit', (code) => {
      if (code !== 0) {
        const suffix = stderrTruncated ? ' [stderr truncated]' : '';
        reject(new Error(`tar exited ${code}: ${stderr.trim()}${suffix}`));
        return;
      }
      // Walk the extracted tree and reject any symlink that escapes destDir.
      Promise.resolve()
        .then(() => postExtractCheck(destDir))
        .then(resolve, reject);
    });
    tar.stdin.on('error', reject);
    tar.stdin.end(buffer);
  });
}

/**
 * Recursively walk `destDir`. Any symlink whose resolved target lies outside
 * `destDir` is unlinked and the walk is rejected with a descriptive error.
 * Intentionally conservative: we resolve the link target relative to the
 * directory containing the link (mimicking how a later reader would resolve
 * it) and compare against the absolute, resolved `destDir`.
 *
 * Exported for tests; not re-exported as part of the module surface.
 */
export async function assertNoEscapingSymlinks(destDir) {
  const root = path.resolve(destDir);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  await walkAndCheck(root, root, rootWithSep);
}

async function walkAndCheck(current, root, rootWithSep) {
  let entries;
  try {
    entries = await fs.promises.readdir(current, { withFileTypes: true });
  } catch (err) {
    // If the directory disappeared mid-walk, treat as benign; if we can't
    // read it for other reasons, surface the failure.
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isSymbolicLink()) {
      let target;
      try {
        target = await fs.promises.readlink(full);
      } catch {
        // Unreadable link — remove defensively rather than trust it.
        try { fs.unlinkSync(full); } catch { /* best-effort */ }
        throw new Error(
          `tarball symlink unreadable and removed: ${path.relative(root, full)}`
        );
      }
      const resolved = path.resolve(path.dirname(full), target);
      const resolvedWithSep = resolved.endsWith(path.sep)
        ? resolved
        : resolved + path.sep;
      const escapes =
        resolved !== root &&
        !resolvedWithSep.startsWith(rootWithSep);
      if (escapes) {
        try { fs.unlinkSync(full); } catch { /* best-effort */ }
        throw new Error(
          `tarball contains symlink escaping destDir: ` +
          `${path.relative(root, full)} -> ${target}`
        );
      }
      // Don't follow symlinks during the walk — even safe ones.
      continue;
    }
    if (entry.isDirectory()) {
      await walkAndCheck(full, root, rootWithSep);
    }
  }
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
