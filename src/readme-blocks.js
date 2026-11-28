/**
 * Shared README blocks (docs/readme-blocks.md, seam temper-fleet/readme-blocks).
 *
 * temper runs the readme-blocks WASI module (wasm32-wasip1) with node:wasi.
 * It refuses a module whose sha256 differs from the configured one, or whose
 * `interface-version` is not INTERFACE_VERSION. The module decides; this file
 * only fetches inputs, maps the module's code onto the report check
 * `readme.shared_blocks`, and writes the sync pull request.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { WASI } from 'node:wasi';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const INTERFACE_VERSION = 1;
export const TEMPLATES_DIR = path.join(__dirname, '..', 'templates', 'readme');
export const VARIABLES_PATH = '.github/pulseengine.yaml';
export const SYNC_BRANCH = 'temper/readme-blocks';
export const CHECK_ID = 'readme.shared_blocks';
const MODULE_CODES = new Set(['ok', 'not_applicable', 'divergent_undeclared']);

export function readmeBlocksSettings(config) {
  const r = config?.readme_blocks || {};
  return {
    enabled: r.enabled === true,
    modulePath: typeof r.module_path === 'string' ? r.module_path : '',
    moduleSha256: typeof r.module_sha256 === 'string' ? r.module_sha256.toLowerCase() : '',
    repos: Array.isArray(r.repos) ? r.repos.filter((x) => typeof x === 'string') : []
  };
}

/**
 * Run the module once with `args`, inside a fresh temp dir preopened at /work.
 * @param {WebAssembly.Module} mod
 * @param {string[]} args
 * @param {Record<string,string>} files - name -> content, written under the dir
 * @returns {{code: number, stdout: string}}
 */
export function runModule(mod, args, files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'temper-readme-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      const p = path.join(dir, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
    const outPath = path.join(dir, '.stdout');
    const out = fs.openSync(outPath, 'w');
    const nul = fs.openSync(os.devNull, 'w');
    let code;
    try {
      const wasi = new WASI({
        version: 'preview1',
        args: ['readme-blocks', ...args],
        env: {},
        preopens: { '/work': dir },
        stdout: out,
        stderr: nul,
        returnOnExit: true
      });
      const instance = new WebAssembly.Instance(mod, wasi.getImportObject());
      code = wasi.start(instance);
    } finally {
      fs.closeSync(out);
      fs.closeSync(nul);
    }
    return { code, stdout: fs.readFileSync(outPath, 'utf8') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Load and verify the module. Throws with the reason when the file is
 * missing, its sha256 differs, or it speaks another interface version.
 */
export function loadModule({ modulePath, moduleSha256 }) {
  if (!modulePath || !/^[0-9a-f]{64}$/.test(moduleSha256)) {
    throw new Error('readme_blocks.module_path and readme_blocks.module_sha256 are required');
  }
  const bytes = fs.readFileSync(modulePath);
  const actual = crypto.createHash('sha256').update(bytes).digest('hex');
  if (actual !== moduleSha256) {
    throw new Error(`module sha256 ${actual} is not the configured ${moduleSha256}`);
  }
  const mod = new WebAssembly.Module(bytes);
  const { code, stdout } = runModule(mod, ['interface-version']);
  const version = stdout.trim();
  if (code !== 0 || version !== String(INTERFACE_VERSION)) {
    throw new Error(`module interface-version ${JSON.stringify(version)} (exit ${code}) is not ${INTERFACE_VERSION}`);
  }
  return mod;
}

function readTemplates(dir = TEMPLATES_DIR) {
  const files = {};
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith('.md')) files[`t/${f}`] = fs.readFileSync(path.join(dir, f), 'utf8');
  }
  return files;
}

/**
 * Check one README. Returns the module's parsed report, or throws when the
 * module could not run (exit 1 or 2) or printed something it does not define.
 */
export function checkReadme(mod, { variables, readme }, templatesDir = TEMPLATES_DIR) {
  const files = { ...readTemplates(templatesDir), 'vars.yaml': variables, 'README.md': readme };
  const { code, stdout } = runModule(mod, [
    'check', '--format', 'json', '--variables', '/work/vars.yaml', '--readme', '/work/README.md', '--templates', '/work/t'
  ], files);
  if (code !== 0) throw new Error(`module exit ${code}`);
  const r = JSON.parse(stdout);
  if (r?.interface !== INTERFACE_VERSION || !MODULE_CODES.has(r.code)) {
    throw new Error('module printed a report this temper does not accept');
  }
  if (r.readme !== undefined && r.readme !== null && typeof r.readme !== 'string') {
    throw new Error('module printed a non-string readme');
  }
  return r;
}

async function getFile(octokit, owner, repo, filePath, ref) {
  try {
    const res = await octokit.request('GET /repos/{owner}/{repo}/contents/{path}', { owner, repo, path: filePath, ref });
    if (typeof res.data?.content !== 'string') return { status: 'not_file' };
    return { status: 200, text: Buffer.from(res.data.content, 'base64').toString('utf8'), sha: res.data.sha };
  } catch (err) {
    return { status: err.status || 'error' };
  }
}

function errorCode(status) {
  return status === 401 || status === 403 ? 'error_permission' : 'error_api';
}

/**
 * Evaluate one repo. Never throws.
 * @returns {{code: string, reason: string, readme?: string, readmeSha?: string}}
 *   code is one of ok, not_applicable, divergent_undeclared, error_api,
 *   error_permission, unknown. reason is for temper's log only.
 */
export async function evaluateReadme(octokit, mod, owner, repo, branch, templatesDir = TEMPLATES_DIR, check = checkReadme) {
  const vars = await getFile(octokit, owner, repo, VARIABLES_PATH, branch);
  if (vars.status === 404) return { code: 'not_applicable', reason: 'no variables file' };
  if (vars.status !== 200) return { code: vars.status === 'not_file' ? 'not_applicable' : errorCode(vars.status), reason: `variables: ${vars.status}` };
  const readme = await getFile(octokit, owner, repo, 'README.md', branch);
  if (readme.status === 404) return { code: 'not_applicable', reason: 'no README.md' };
  if (readme.status !== 200) return { code: readme.status === 'not_file' ? 'not_applicable' : errorCode(readme.status), reason: `README.md: ${readme.status}` };
  try {
    const r = check(mod, { variables: vars.text, readme: readme.text }, templatesDir);
    const out = { code: r.code, reason: r.reason || '' };
    if (typeof r.readme === 'string' && r.readme !== readme.text) {
      out.readme = r.readme;
      out.readmeSha = readme.sha;
    }
    return out;
  } catch (err) {
    return { code: 'unknown', reason: err.message };
  }
}

/** The report check for one repo's evaluation (severity low, no notes). */
export function readmeCheck(code) {
  const undecided = code === 'unknown' || code === 'error_api' || code === 'error_permission';
  return { id: CHECK_ID, ok: undecided ? null : code !== 'divergent_undeclared', severity: 'low', code };
}

const PR_TITLE = 'docs(readme): sync the shared PulseEngine README blocks';
const PR_BODY = [
  'temper synced the text between this README\'s `<!-- pulseengine:NAME -->` markers with',
  'the shared templates in pulseengine/temper (`templates/readme/`). Nothing outside a',
  'marker pair changed. Contract: docs/readme-blocks.md in pulseengine/temper.',
  '',
  'temper does not arm auto-merge on this PR. Merge it once the required checks pass,',
  'or remove a block\'s markers if this repo wants that block different.'
].join('\n');

/**
 * Write or update the one sync PR for a repo, on SYNC_BRANCH. The branch is
 * reset to the default branch head and README.md committed through the
 * contents API, so GitHub signs the commit. Never arms auto-merge.
 * @returns {Promise<{action: 'opened'|'updated'|'unchanged', number?: number}>}
 */
export async function writeSyncPr(octokit, owner, repo, branch, readme) {
  const head = await octokit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { owner, repo, ref: `heads/${branch}` });
  const base = head.data.object.sha;
  const open = await octokit.request('GET /repos/{owner}/{repo}/pulls', { owner, repo, state: 'open', head: `${owner}:${SYNC_BRANCH}`, per_page: 10 });
  const pr = open.data[0];

  if (pr) {
    const onBranch = await getFile(octokit, owner, repo, 'README.md', SYNC_BRANCH);
    if (onBranch.status === 200 && onBranch.text === readme && pr.base?.sha === base) return { action: 'unchanged', number: pr.number };
  }

  try {
    await octokit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', { owner, repo, ref: `heads/${SYNC_BRANCH}`, sha: base, force: true });
  } catch (err) {
    if (err.status !== 404 && err.status !== 422) throw err;
    await octokit.request('POST /repos/{owner}/{repo}/git/refs', { owner, repo, ref: `refs/heads/${SYNC_BRANCH}`, sha: base });
  }
  const current = await getFile(octokit, owner, repo, 'README.md', SYNC_BRANCH);
  if (current.status !== 200) throw new Error(`README.md on ${SYNC_BRANCH}: ${current.status}`);
  await octokit.request('PUT /repos/{owner}/{repo}/contents/{path}', {
    owner,
    repo,
    path: 'README.md',
    branch: SYNC_BRANCH,
    sha: current.sha,
    message: PR_TITLE,
    content: Buffer.from(readme, 'utf8').toString('base64')
  });
  if (pr) return { action: 'updated', number: pr.number };
  const created = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
    owner, repo, title: PR_TITLE, body: PR_BODY, head: SYNC_BRANCH, base: branch
  });
  return { action: 'opened', number: created.data.number };
}
