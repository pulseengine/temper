/**
 * The report sweep: every `report.sweep_interval_hours`, evaluate every repo
 * a sync would touch against the standards (read-only), and write
 * temper-report.v1 for warte. `last_sweep_at` moves only when a sweep
 * completed, and it survives restarts, because warte flags the report stale
 * after twice the interval.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { getConfig } from './config.js';
import { getLogger } from './logger.js';
import { fetchSnapshot, evaluateRepo, getStandards } from './standards.js';
import { selectSyncTargets } from './organization.js';
import { buildReport, repoEntry, writeReport, iso, MAX_REPOS } from './report.js';
import { trackOctokit, apiSnapshot, reviewTotals } from './report-stats.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const HOUR = 60 * 60 * 1000;
export const DEFAULT_REPORT_PATH = '/var/lib/temper/report.json';

export function reportSettings(config = getConfig()) {
  const r = config?.report || {};
  return {
    enabled: r.enabled === true,
    path: process.env.TEMPER_REPORT_PATH || r.path || DEFAULT_REPORT_PATH,
    intervalMs: (Number(r.sweep_interval_hours) > 0 ? Number(r.sweep_interval_hours) : 12) * HOUR,
    windowDays: Number(r.review_window_days) > 0 ? Math.floor(Number(r.review_window_days)) : 7
  };
}

/** version, commit and config hash of the running temper. */
export function buildInfo(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  let commit = process.env.TEMPER_COMMIT || '';
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    try {
      commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', env: {} }).trim();
    } catch {
      commit = '';
    }
  }
  const h = crypto.createHash('sha256');
  for (const f of ['config.yml', 'config.local.yml']) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) h.update(fs.readFileSync(p));
  }
  return { version: pkg.version, commit, config_sha256: h.digest('hex') };
}

/**
 * One sweep. Throws if the repo list cannot be read; per-repo read failures
 * become error_* checks instead.
 */
export async function sweepOrg(octokit, org, std, now = Date.now) {
  const all = await octokit.paginate('GET /orgs/{org}/repos', { org, type: 'all', per_page: 100 });
  const targets = selectSyncTargets(all).sort((a, b) => a.name.localeCompare(b.name));
  const repos = [];
  for (const r of targets) {
    const snap = await fetchSnapshot(octokit, org, r.name);
    const entry = repoEntry(snap, evaluateRepo(snap, std), iso(now()));
    if (entry) repos.push(entry);
  }
  return repos;
}

async function rateNow(octokit, now) {
  const snap = apiSnapshot(now);
  let rate = snap.rate;
  try {
    const res = await octokit.request('GET /rate_limit');
    const core = res.data?.resources?.core;
    if (core) rate = { remaining: core.remaining, limit: core.limit, reset_at_ms: core.reset * 1000 };
  } catch {
    // keep the last headers we saw
  }
  rate = rate || { remaining: 0, limit: 0, reset_at_ms: now };
  return {
    calls_last_hour: apiSnapshot(now).calls_last_hour,
    remaining: rate.remaining,
    limit: rate.limit,
    reset_at: iso(rate.reset_at_ms)
  };
}

/**
 * @param {object} deps
 * @param {Function} deps.octokitFactory - installation-scoped Octokit per run
 * @param {string} deps.org
 * @param {object} [deps.taskStore] - getReportStats()
 * @param {object} [deps.stateStore] - KV {get,set} for last_sweep_at
 */
export function createReportSweep({ octokitFactory, org, taskStore, stateStore, config = getConfig(), clock = Date.now }) {
  const settings = reportSettings(config);
  let lastSweepAt = Number(stateStore?.get('last_sweep_at')) || null;
  let running = false;
  let timer = null;

  async function run() {
    if (running) return { written: false, error: 'already running' };
    running = true;
    try {
      const octokit = trackOctokit(await octokitFactory());
      const repos = await sweepOrg(octokit, org, getStandards(config), clock);
      if (repos.length > MAX_REPOS) {
        getLogger().error({ repos: repos.length, max: MAX_REPOS }, 'report: too many repos; previous report kept');
        return { written: false, error: 'too many repos' };
      }
      lastSweepAt = clock();
      stateStore?.set('last_sweep_at', String(lastSweepAt));
      const now = clock();
      const report = buildReport({
        org,
        now,
        build: buildInfo(),
        source: { trigger: 'sweep', last_sweep_at: iso(lastSweepAt), api: await rateNow(octokit, now) },
        repos,
        reviews: reviewTotals(settings.windowDays, now),
        tasks: taskStore?.getReportStats(now) ||
          { pending: 0, in_progress: 0, failed: 0, oldest_pending_age_s: 0, stale_in_progress: 0 }
      });
      const res = writeReport(settings.path, report);
      if (res.written) getLogger().info({ path: settings.path, bytes: res.bytes, repos: repos.length }, 'report: written');
      else getLogger().error({ error: res.error }, 'report: not written; previous report kept');
      return res;
    } catch (err) {
      getLogger().error({ err: err.message }, 'report: sweep failed; previous report kept');
      return { written: false, error: err.message };
    } finally {
      running = false;
    }
  }

  function due(now = clock()) {
    return !lastSweepAt || now - lastSweepAt >= settings.intervalMs;
  }

  function start({ checkEveryMs = 15 * 60 * 1000, firstAfterMs = 2 * 60 * 1000 } = {}) {
    const tick = () => { if (due()) run(); };
    setTimeout(tick, firstAfterMs).unref?.();
    timer = setInterval(tick, checkEveryMs);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { run, due, start, stop, settings, get lastSweepAt() { return lastSweepAt; } };
}
