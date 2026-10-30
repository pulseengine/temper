/**
 * Dry-run planner: for each repo a sync would touch, report standards drift
 * and the exact writes the sync would send — without sending any.
 *
 * Drift comes from `evaluateRepo` (the one drift function). Writes come from
 * running the real `configureRepository` against the recording octokit from
 * `dry-run.js`, so nothing here re-implements apply logic.
 */

import fs from 'fs';
import path from 'path';
import { getConfig } from './config.js';
import { configureRepository } from './repository.js';
import { selectSyncTargets } from './organization.js';
import { createDryRunOctokit } from './dry-run.js';
import { getStandards, fetchSnapshot, evaluateRepo, hasDrift, loadSnapshotDir } from './standards.js';

/**
 * @param {object} realOctokit - used for reads only
 * @param {string} org
 * @param {object} [opts]
 * @param {string[]} [opts.repos] - restrict to these repo names
 * @param {string|null} [opts.cacheDir]
 * @param {number} [opts.minIntervalMs]
 * @param {object} [opts.dryOctokit] - inject (tests)
 */
export async function planOrg(realOctokit, org, { repos = null, cacheDir = null, minIntervalMs = 1000, dryOctokit } = {}) {
  const dry = dryOctokit || createDryRunOctokit(realOctokit, { cacheDir, minIntervalMs });
  const std = getStandards(getConfig());
  const all = await dry.paginate('GET /orgs/{org}/repos', { org, type: 'all', per_page: 100 });
  const targets = selectSyncTargets(all)
    .filter((r) => !repos || repos.includes(r.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  const results = [];
  for (const repo of targets) {
    dry.drainWrites();
    const snap = await fetchSnapshot(dry, org, repo.name);
    const evaluation = evaluateRepo(snap, std);
    dry.drainWrites();
    const res = await configureRepository(dry, repo);
    const writes = dry.drainWrites();
    results.push({
      repo: repo.name,
      visibility: repo.visibility,
      fork: repo.fork,
      scope: evaluation.scope,
      blocker: evaluation.blocker,
      drift: hasDrift(evaluation),
      findings: evaluation.findings,
      writes,
      error: res.success ? null : res.error
    });
  }
  return { org, generated_at: new Date().toISOString(), stats: dry.stats, results };
}

/** Offline: evaluate sweep-cache snapshot dirs (no writes plan, no network). */
export function auditSnapshots(rootDir, { repos = null } = {}) {
  const std = getStandards(getConfig());
  const names = fs
    .readdirSync(rootDir)
    .filter((n) => fs.statSync(path.join(rootDir, n)).isDirectory())
    .filter((n) => !repos || repos.includes(n))
    .sort();
  return names.map((n) => {
    const ev = evaluateRepo(loadSnapshotDir(path.join(rootDir, n)), std);
    return { repo: n, scope: ev.scope, blocker: ev.blocker, drift: hasDrift(ev), findings: ev.findings };
  });
}

/** Render plan/audit results as plain text. */
export function renderPlan(results, { showOk = false } = {}) {
  const lines = [];
  for (const r of results) {
    const head = `${r.repo}${r.visibility === 'private' ? ' (private)' : ''}${r.fork ? ' (fork)' : ''}`;
    lines.push(`\n## ${head} — ${r.scope}${r.drift ? ', DRIFT' : ''}${r.error ? `, ERROR: ${r.error}` : ''}`);
    if (r.blocker) lines.push(`   blocker: ${r.blocker}`);
    for (const f of r.findings) {
      if (!f.drift && !showOk) continue;
      lines.push(`   ${f.drift ? 'x' : 'ok'} ${f.rule}: intended ${f.intended} | actual ${f.actual}${f.fix ? ` | fix: ${f.fix}` : ''}${f.note ? ` | ${f.note}` : ''}`);
    }
    for (const w of r.writes || []) {
      const body = JSON.stringify(w.body);
      lines.push(`   -> ${w.method} ${w.url} ${body.length > 400 ? body.slice(0, 400) + '…' : body}`);
    }
  }
  return lines.join('\n') + '\n';
}
