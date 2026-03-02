import { getConfig } from './config.js';
import { getLogger } from './logger.js';
import { analyzeOrganizationRepositories, synchronizeAllRepositories, generateOrganizationAnalysisReport } from './organization.js';
import { checkDependabotConfiguration, checkExistingDependabotConfig, fixDependabotPRLabels } from './dependabot.js';
import { generateConfigurationReport } from './reporting.js';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

// ── Cache ────────────────────────────────────────────────────────────
const cache = { data: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000;
function isCacheValid() { return cache.data && (Date.now() - cache.timestamp) < CACHE_TTL; }
export function invalidateCache() { cache.data = null; cache.timestamp = 0; }

// ── Octokit ──────────────────────────────────────────────────────────
let _octokit = null;
async function getOctokit() {
  if (_octokit) return _octokit;
  const appId = process.env.APP_ID;
  const privateKey = (process.env.PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const appOctokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey } });
  const { data: installations } = await appOctokit.apps.listInstallations();
  const inst = installations.find(i => i.account?.login === getConfig()?.organization);
  if (!inst) throw new Error('No installation found for org');
  _octokit = new Octokit({ authStrategy: createAppAuth, auth: { appId, privateKey, installationId: inst.id } });
  return _octokit;
}

// ── Data fetching ────────────────────────────────────────────────────
async function fetchOrgData() {
  if (isCacheValid()) return cache.data;
  const octokit = await getOctokit();
  const config = getConfig();
  const org = config?.organization || 'pulseengine';
  const analysis = await analyzeOrganizationRepositories(octokit, org);
  if (!analysis.success) throw new Error(analysis.error);
  const repos = analysis.repositories;

  // Enrich each repo with CI, signed commits, auto-merge, open PRs
  const enrichPromises = repos.map(async (repo) => {
    // CI status
    try {
      const { data: runs } = await octokit.actions.listWorkflowRunsForRepo({ owner: org, repo: repo.name, per_page: 1 });
      const run = runs.workflow_runs?.[0];
      repo.ci_status = run ? { status: run.conclusion || run.status, updated_at: run.updated_at, url: run.html_url } : { status: 'none' };
    } catch { repo.ci_status = { status: 'none' }; }
    // Repo details (auto-merge)
    try {
      const { data: rd } = await octokit.repos.get({ owner: org, repo: repo.name });
      repo.auto_merge_enabled = rd.allow_auto_merge || false;
    } catch { repo.auto_merge_enabled = false; }
    // Signed commits
    try {
      await octokit.repos.getCommitSignatureProtection({ owner: org, repo: repo.name, branch: repo.configurations?.default_branch || 'main' });
      repo.signed_commits_required = true;
    } catch { repo.signed_commits_required = false; }
    // Open PRs
    try {
      const { data: prs } = await octokit.pulls.list({ owner: org, repo: repo.name, state: 'open', per_page: 10 });
      repo.open_prs = prs.map(pr => ({
        number: pr.number, title: pr.title, url: pr.html_url,
        user: pr.user?.login, created_at: pr.created_at, draft: pr.draft,
        labels: pr.labels?.map(l => l.name) || [],
        head: pr.head?.ref, base: pr.base?.ref,
      }));
    } catch { repo.open_prs = []; }
  });
  await Promise.all(enrichPromises);

  // Collect all open PRs across repos, with CI check status
  const allPRs = [];
  for (const repo of repos) {
    for (const pr of (repo.open_prs || [])) {
      let checkStatus = 'unknown';
      try {
        const { data: checks } = await octokit.checks.listForRef({ owner: org, repo: repo.name, ref: pr.head });
        const runs = checks.check_runs || [];
        if (runs.length === 0) checkStatus = 'none';
        else if (runs.every(r => r.conclusion === 'success')) checkStatus = 'pass';
        else if (runs.some(r => r.conclusion === 'failure')) checkStatus = 'fail';
        else if (runs.some(r => r.status === 'in_progress' || r.status === 'queued')) checkStatus = 'running';
        else checkStatus = 'pending';
      } catch { checkStatus = 'unknown'; }
      allPRs.push({ ...pr, repo: repo.name, checkStatus });
    }
  }

  const result = {
    org, config,
    timestamp: new Date().toISOString(),
    repos: repos.sort((a, b) => a.name.localeCompare(b.name)),
    prs: allPRs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)),
    summary: buildSummary(repos, config),
  };
  cache.data = result;
  cache.timestamp = Date.now();
  return result;
}

function buildSummary(repos, config) {
  const total = repos.length;
  const targetMerge = config?.settings?.merge || {};
  const withProtection = repos.filter(r => r.configurations?.branch_protection?.exists).length;
  const withCI = repos.filter(r => r.ci_status?.status && r.ci_status.status !== 'none').length;
  const ciPassing = repos.filter(r => r.ci_status?.status === 'success').length;
  const withSigned = repos.filter(r => r.signed_commits_required).length;
  const withAutoMerge = repos.filter(r => r.auto_merge_enabled).length;
  const targetLabels = (config?.issue_labels || []).length;
  const withAllLabels = repos.filter(r => (r.configurations?.labels?.standard_labels?.length || 0) >= targetLabels).length;
  const correctMerge = repos.filter(r => {
    const m = r.configurations?.merge_settings;
    if (!m) return false;
    return (!!m.allow_merge_commit === !!targetMerge.allow_merge_commit) &&
           (!!m.allow_squash_merge === !!targetMerge.allow_squash_merge) &&
           (!!m.allow_rebase_merge === !!targetMerge.allow_rebase_merge);
  }).length;
  const totalPRs = repos.reduce((n, r) => n + (r.open_prs?.length || 0), 0);

  const issues = [];
  repos.forEach(r => {
    if (!r.configurations?.branch_protection?.exists) issues.push({ repo: r.name, type: 'protection', msg: 'No branch protection' });
    const m = r.configurations?.merge_settings;
    if (m && ((!!m.allow_merge_commit !== !!targetMerge.allow_merge_commit) || (!!m.allow_squash_merge !== !!targetMerge.allow_squash_merge) || (!!m.allow_rebase_merge !== !!targetMerge.allow_rebase_merge)))
      issues.push({ repo: r.name, type: 'merge', msg: 'Merge settings drift' });
    if (!r.signed_commits_required) issues.push({ repo: r.name, type: 'signed', msg: 'Signed commits not required' });
    if (!r.auto_merge_enabled) issues.push({ repo: r.name, type: 'auto-merge', msg: 'Auto-merge not enabled' });
    if ((r.configurations?.labels?.standard_labels?.length || 0) < targetLabels)
      issues.push({ repo: r.name, type: 'labels', msg: `Missing ${targetLabels - (r.configurations?.labels?.standard_labels?.length || 0)} labels` });
  });
  return { total, withProtection, withCI, ciPassing, withSigned, withAutoMerge, correctMerge, withAllLabels, targetLabels, totalPRs, issues };
}

// ── Rendering helpers ────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function badge(cls, label) { return `<span class="badge ${cls}">${esc(label)}</span>`; }
function okBadge(ok, y, n) { return ok ? badge('badge-ok', y || 'yes') : badge('badge-warn', n || 'no'); }
function ciBadge(status) {
  const m = { success:['badge-ok','pass'], failure:['badge-err','fail'], cancelled:['badge-warn','cancelled'],
    in_progress:['badge-info','running'], queued:['badge-info','queued'], none:['badge-muted','none'],
    pass:['badge-ok','pass'], fail:['badge-err','fail'], running:['badge-info','running'],
    pending:['badge-warn','pending'], unknown:['badge-muted','?'] };
  const [c,l] = m[status] || ['badge-muted', status || '?'];
  return badge(c, l);
}
function mergeLabel(s) {
  if (!s || s.error) return badge('badge-muted','?');
  const p = [];
  if (s.allow_merge_commit) p.push('merge');
  if (s.allow_squash_merge) p.push('squash');
  if (s.allow_rebase_merge) p.push('rebase');
  return badge(p.length <= 2 ? 'badge-ok' : 'badge-warn', p.join('+') || 'none');
}
function timeAgo(d) {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff/60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m/60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h/24)}d ago`;
}

// ── Partials ─────────────────────────────────────────────────────────
function renderSummaryPartial(data) {
  const s = data.summary;
  const t = s.total;
  const score = t === 0 ? 0 : Math.round(((s.withProtection + s.correctMerge + s.withSigned + s.withAutoMerge + s.withAllLabels) / (t * 5)) * 100);

  function card(value, label, cls, icon) {
    return `<div class="metric-card ${cls}">
      <div class="metric-icon">${icon}</div>
      <div class="metric-body"><div class="metric-value">${value}</div><div class="metric-label">${label}</div></div>
    </div>`;
  }
  function ring(pct) {
    const c = pct >= 90 ? 'var(--green)' : pct >= 70 ? 'var(--amber)' : 'var(--red)';
    const deg = Math.round(pct * 3.6);
    return `<div class="compliance-ring" style="background:conic-gradient(${c} ${deg}deg, var(--surface) ${deg}deg)">
      <div class="compliance-inner"><span class="compliance-pct">${pct}%</span><span class="compliance-lbl">Compliance</span></div>
    </div>`;
  }

  return `<div class="summary-grid">
    <div class="summary-left">${ring(score)}</div>
    <div class="summary-right">
      ${card(t, 'Repositories', '', '&#9632;')}
      ${card(s.withProtection + '/' + t, 'Protected', s.withProtection === t ? 'ok' : 'warn', '&#9711;')}
      ${card(s.withSigned + '/' + t, 'Signed', s.withSigned === t ? 'ok' : 'warn', '&#9670;')}
      ${card(s.ciPassing + '/' + s.withCI, 'CI Passing', s.ciPassing === s.withCI ? 'ok' : 'warn', '&#9654;')}
      ${card(s.correctMerge + '/' + t, 'Merge OK', s.correctMerge === t ? 'ok' : 'warn', '&#9830;')}
      ${card(s.withAutoMerge + '/' + t, 'Auto-Merge', s.withAutoMerge === t ? 'ok' : 'warn', '&#8635;')}
      ${card(s.withAllLabels + '/' + t, 'Labels', s.withAllLabels === t ? 'ok' : 'warn', '&#9679;')}
      ${card(s.totalPRs, 'Open PRs', s.totalPRs > 0 ? 'info' : '', '&#8693;')}
    </div>
  </div>`;
}

function renderPolicyPartial(data) {
  const config = data.config || {};
  const merge = config?.settings?.merge || {};
  const bp = config?.branch_protection?.default || {};
  const am = config?.auto_merge || {};
  const checks = bp?.required_status_checks?.contexts || [];
  const labels = (config?.issue_labels || []).map(l => l.name);

  function row(label, value, detail) {
    return `<tr><td class="policy-key">${esc(label)}</td><td>${value}</td>${detail ? `<td class="text-dim">${esc(detail)}</td>` : '<td></td>'}</tr>`;
  }

  return `<div class="policy-grid">
    <div class="glass-card">
      <div class="card-header"><span class="card-icon">&#9830;</span> Merge Strategy</div>
      <table class="kv-table">
        ${row('Merge commit', okBadge(merge.allow_merge_commit, 'allowed', 'blocked'), 'Preserves commit signatures')}
        ${row('Squash merge', okBadge(merge.allow_squash_merge, 'allowed', 'blocked'), 'GitHub signs squash commits')}
        ${row('Rebase merge', merge.allow_rebase_merge ? badge('badge-warn','allowed') : badge('badge-ok','blocked'), 'Cannot be signed by GitHub')}
        ${row('Delete branch', okBadge(merge.delete_branch_on_merge), '')}
        ${row('Auto-merge', okBadge(merge.allow_auto_merge), '')}
      </table>
    </div>
    <div class="glass-card">
      <div class="card-header"><span class="card-icon">&#9711;</span> Branch Protection</div>
      <table class="kv-table">
        ${row('Enforce admins', bp.enforce_admins ? badge('badge-warn','yes') : badge('badge-ok','no'), bp.enforce_admins ? 'Admins subject to rules' : 'Admin can bypass')}
        ${row('PR reviews', bp.required_pull_request_reviews === null ? badge('badge-ok','none') : badge('badge-warn', JSON.stringify(bp.required_pull_request_reviews)), '')}
        ${row('Signed commits', okBadge(bp.require_signed_commits, 'required', 'not required'), '')}
        ${row('Linear history', okBadge(bp.required_linear_history, 'required', 'not required'), '')}
        ${row('Force pushes', bp.allow_force_pushes ? badge('badge-err','allowed') : badge('badge-ok','blocked'), '')}
        ${row('Deletions', bp.allow_deletions ? badge('badge-err','allowed') : badge('badge-ok','blocked'), '')}
        ${row('Status checks', checks.length > 0 ? badge('badge-info', checks.join(', ')) : badge('badge-muted','none configured'), '')}
      </table>
    </div>
    <div class="glass-card">
      <div class="card-header"><span class="card-icon">&#8635;</span> Auto-Merge Rules</div>
      <table class="kv-table">
        ${row('Enabled', okBadge(am.enabled), '')}
        ${row('Dependabot PRs', okBadge(am.on_dependabot), '')}
        ${row('Bot users', (am.on_bot_users||[]).length > 0 ? badge('badge-info',(am.on_bot_users||[]).join(', ')) : badge('badge-muted','none'), '')}
        ${row('Method', badge('badge-info', am.merge_method || 'squash'), '')}
      </table>
    </div>
    <div class="glass-card">
      <div class="card-header"><span class="card-icon">&#9679;</span> Standard Labels (${labels.length})</div>
      <div class="label-grid">${labels.map(l => `<span class="label-chip">${esc(l)}</span>`).join('')}</div>
    </div>
  </div>`;
}

function renderReposPartial(data) {
  const rows = data.repos.map(r => {
    const bp = r.configurations?.branch_protection || {};
    const ms = r.configurations?.merge_settings || {};
    const dep = r.configurations?.dependabot || {};
    const lbls = r.configurations?.labels || {};
    const targetLabels = (data.config?.issue_labels || []).length;
    const hasAllLabels = (lbls.standard_labels?.length || 0) >= targetLabels;
    const prCount = r.open_prs?.length || 0;

    return `<tr>
      <td><a class="repo-link" href="https://github.com/${esc(data.org)}/${esc(r.name)}" target="_blank">${esc(r.name)}</a>${prCount > 0 ? ` <span class="pr-count">${prCount} PR${prCount>1?'s':''}</span>` : ''}</td>
      <td>${okBadge(bp.exists)}</td>
      <td>${okBadge(r.signed_commits_required)}</td>
      <td>${ciBadge(r.ci_status?.status)}</td>
      <td>${mergeLabel(ms)}</td>
      <td>${okBadge(r.auto_merge_enabled)}</td>
      <td>${okBadge(dep.exists)}</td>
      <td>${hasAllLabels ? badge('badge-ok', (lbls.standard_labels?.length||0)+'/'+targetLabels) : badge('badge-warn',(lbls.standard_labels?.length||0)+'/'+targetLabels)}</td>
      <td class="text-dim">${esc(timeAgo(r.updated_at))}</td>
    </tr>`;
  }).join('');

  return `<table class="data-table">
    <thead><tr>
      <th class="sortable">Repository <span class="sort-arrow">&#9650;</span></th><th class="sortable">Protected <span class="sort-arrow">&#9650;</span></th><th class="sortable">Signed <span class="sort-arrow">&#9650;</span></th><th class="sortable">CI <span class="sort-arrow">&#9650;</span></th>
      <th class="sortable">Merge <span class="sort-arrow">&#9650;</span></th><th class="sortable">Auto <span class="sort-arrow">&#9650;</span></th><th class="sortable">Dependabot <span class="sort-arrow">&#9650;</span></th><th class="sortable">Labels <span class="sort-arrow">&#9650;</span></th><th class="sortable">Updated <span class="sort-arrow">&#9650;</span></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function ageClass(dateStr) {
  if (!dateStr) return '';
  const days = (Date.now() - new Date(dateStr).getTime()) / 86400000;
  if (days < 1) return 'age-new';
  if (days < 7) return 'age-mid';
  return 'age-old';
}

function renderPRsPartial(data) {
  if (data.prs.length === 0) {
    return `<div class="empty-state"><span class="empty-icon">&#10003;</span> No open pull requests across any repositories.</div>`;
  }

  // Group PRs by repo
  const byRepo = {};
  data.prs.forEach(pr => {
    if (!byRepo[pr.repo]) byRepo[pr.repo] = [];
    byRepo[pr.repo].push(pr);
  });

  // Sort repos by oldest PR first (most urgent)
  const repoEntries = Object.entries(byRepo).sort((a, b) => {
    const oldestA = Math.min(...a[1].map(p => new Date(p.created_at).getTime()));
    const oldestB = Math.min(...b[1].map(p => new Date(p.created_at).getTime()));
    return oldestA - oldestB;
  });

  const groups = repoEntries.map(([repo, prs]) => {
    // Sort PRs within repo by age (oldest first)
    prs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const statusBadges = [];
    const passing = prs.filter(p => p.checkStatus === 'pass' || p.checkStatus === 'success').length;
    const failing = prs.filter(p => p.checkStatus === 'fail' || p.checkStatus === 'failure').length;
    if (failing > 0) statusBadges.push(badge('badge-err', failing + ' failing'));
    if (passing > 0) statusBadges.push(badge('badge-ok', passing + ' passing'));

    const rows = prs.map(pr => {
      return `<tr>
        <td><a class="pr-link" href="${esc(pr.url)}" target="_blank">#${pr.number}</a> ${esc(pr.title)}${pr.draft ? ' <span class="badge badge-muted">draft</span>' : ''}</td>
        <td>${ciBadge(pr.checkStatus)}</td>
        <td class="text-dim">${esc(pr.user)}</td>
        <td>${(pr.labels||[]).map(l => `<span class="label-chip-sm">${esc(l)}</span>`).join(' ')}</td>
        <td class="${ageClass(pr.created_at)}">${esc(timeAgo(pr.created_at))}</td>
      </tr>`;
    }).join('');

    return `<div class="pr-group${prs.length <= 3 ? ' open' : ''}">
      <div class="pr-group-header" onclick="this.parentElement.classList.toggle('open')">
        <span class="chevron">&#9654;</span>
        <span class="pr-group-name"><a href="https://github.com/${esc(data.org)}/${esc(repo)}" target="_blank">${esc(repo)}</a></span>
        <span class="pr-group-count">${prs.length} PR${prs.length > 1 ? 's' : ''}</span>
        <div class="pr-group-meta">${statusBadges.join(' ')}</div>
      </div>
      <div class="pr-group-body">
        <table class="data-table">
          <thead><tr><th>Pull Request</th><th>Checks</th><th>Author</th><th>Labels</th><th>Age</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;
  }).join('');

  return `<div class="section-meta text-dim" style="margin-bottom:12px">${data.prs.length} open across ${repoEntries.length} repos</div>${groups}`;
}

function renderIssuesPartial(data) {
  const issues = data.summary.issues;
  if (issues.length === 0) {
    return `<div class="empty-state"><span class="empty-icon">&#10003;</span> All repositories are compliant. No drift detected.</div>`;
  }
  const byRepo = {};
  issues.forEach(i => { if (!byRepo[i.repo]) byRepo[i.repo] = []; byRepo[i.repo].push(i); });
  const rows = Object.entries(byRepo).map(([repo, items]) => {
    const badges = items.map(i => badge(i.type === 'protection' ? 'badge-err' : 'badge-warn', i.msg)).join(' ');
    return `<tr><td><span class="repo-link">${esc(repo)}</span></td><td>${badges}</td></tr>`;
  }).join('');

  return `<div class="issues-banner">${badge('badge-err', issues.length + ' issues')} across ${Object.keys(byRepo).length} repos</div>
    <table class="data-table"><thead><tr><th>Repository</th><th>Issues</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ── Main HTML page ───────────────────────────────────────────────────
function renderDashboardPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Temper — Governance</title>
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
<script src="https://unpkg.com/idiomorph@0.3.0/dist/idiomorph-ext.min.js"></script>
<style>
:root {
  --bg: #0a0c10;
  --bg-subtle: #0d1017;
  --surface: #151921;
  --surface-raised: #1c2130;
  --surface-glass: rgba(21,25,33,.72);
  --border: #252d3d;
  --border-subtle: #1e2535;
  --text: #e6eaf3;
  --text-dim: #7c8496;
  --text-faint: #515869;
  --accent: #7b93ff;
  --accent-glow: rgba(123,147,255,.12);
  --green: #4ade80;
  --green-glow: rgba(74,222,128,.08);
  --red: #f87171;
  --amber: #fbbf24;
  --cyan: #22d3ee;
  --purple: #c084fc;
}
*, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  background: var(--bg);
  color: var(--text);
  font-size: 13px;
  line-height: 1.55;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: var(--surface-raised); padding: 2px 6px; border-radius: 4px; font-size: 12px; font-family: 'JetBrains Mono', 'Fira Code', monospace; }

/* Layout — sidebar + main */
.layout { display: flex; min-height: 100vh; }
.sidebar {
  width: 220px; flex-shrink: 0;
  background: var(--bg-subtle);
  border-right: 1px solid var(--border-subtle);
  padding: 20px 0;
  display: flex; flex-direction: column;
}
.sidebar-brand {
  padding: 0 20px 20px;
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 8px;
}
.brand-name { font-size: 17px; font-weight: 700; color: var(--accent); letter-spacing: -0.3px; }
.brand-sub { font-size: 10px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 1px; margin-top: 2px; }
.nav-section { padding: 12px 12px 4px; font-size: 9px; text-transform: uppercase; letter-spacing: 1.2px; color: var(--text-faint); }
.nav-item {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 20px;
  color: var(--text-dim);
  cursor: pointer;
  transition: all .12s;
  border-left: 2px solid transparent;
  font-size: 13px;
}
.nav-item:hover { color: var(--text); background: var(--accent-glow); }
.nav-item.active { color: var(--accent); border-left-color: var(--accent); background: var(--accent-glow); }
.nav-icon { font-size: 15px; width: 20px; text-align: center; opacity: .7; }
.nav-item.active .nav-icon { opacity: 1; }
.nav-badge { margin-left: auto; font-size: 10px; padding: 1px 6px; border-radius: 8px; background: var(--surface-raised); color: var(--text-dim); }
.sidebar-footer {
  margin-top: auto; padding: 16px 20px;
  border-top: 1px solid var(--border-subtle);
  font-size: 10px; color: var(--text-faint);
}
.main { flex: 1; overflow-y: auto; }
.main-header {
  padding: 16px 28px;
  border-bottom: 1px solid var(--border-subtle);
  display: flex; justify-content: space-between; align-items: center;
  background: var(--bg-subtle);
  position: sticky; top: 0; z-index: 10;
}
.page-title { font-size: 15px; font-weight: 600; }
.header-actions { display: flex; gap: 8px; align-items: center; }
.main-content { padding: 24px 28px; }

/* Compliance ring */
.summary-grid { display: flex; gap: 28px; align-items: center; margin-bottom: 28px; }
.summary-left { flex-shrink: 0; }
.compliance-ring {
  width: 120px; height: 120px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 0 24px var(--green-glow);
}
.compliance-inner {
  width: 90px; height: 90px;
  border-radius: 50%;
  background: var(--bg);
  display: flex; flex-direction: column;
  align-items: center; justify-content: center;
}
.compliance-pct { font-size: 26px; font-weight: 700; color: var(--green); }
.compliance-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: var(--text-faint); margin-top: 1px; }

/* Metric cards */
.summary-right { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; flex: 1; }
.metric-card {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  transition: border-color .15s;
}
.metric-card:hover { border-color: var(--border); }
.metric-card.ok { border-left: 3px solid var(--green); }
.metric-card.warn { border-left: 3px solid var(--amber); }
.metric-card.info { border-left: 3px solid var(--cyan); }
.metric-icon { font-size: 16px; color: var(--text-faint); width: 20px; text-align: center; }
.metric-value { font-size: 18px; font-weight: 700; }
.metric-card.ok .metric-value { color: var(--green); }
.metric-card.warn .metric-value { color: var(--amber); }
.metric-card.info .metric-value { color: var(--cyan); }
.metric-label { font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: .5px; }

/* Glass cards (policy) */
.policy-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
.glass-card {
  background: var(--surface-glass);
  backdrop-filter: blur(12px);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  padding: 18px;
}
.card-header {
  font-size: 12px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .6px;
  color: var(--text-dim);
  margin-bottom: 14px;
  display: flex; align-items: center; gap: 8px;
}
.card-icon { color: var(--accent); }
.kv-table { width: 100%; border-collapse: collapse; }
.kv-table td { padding: 6px 0; border-bottom: 1px solid var(--border-subtle); font-size: 13px; }
.kv-table tr:last-child td { border-bottom: none; }
.policy-key { color: var(--text); min-width: 120px; }
.text-dim { color: var(--text-dim); font-size: 12px; }

/* Data table */
.data-table {
  width: 100%;
  border-collapse: collapse;
  background: var(--surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
  overflow: hidden;
}
.data-table th {
  text-align: left; padding: 10px 14px;
  font-size: 10px; text-transform: uppercase; letter-spacing: .8px;
  color: var(--text-faint);
  background: var(--surface-raised);
  border-bottom: 1px solid var(--border);
}
.data-table td {
  padding: 8px 14px;
  border-bottom: 1px solid var(--border-subtle);
  transition: background .12s;
  vertical-align: middle;
}
.data-table tr:last-child td { border-bottom: none; }
.data-table tbody tr:hover td { background: rgba(123,147,255,.04); }
.repo-link { font-weight: 600; color: var(--accent); }
.pr-link { font-weight: 600; color: var(--accent); }
.pr-count { font-size: 10px; padding: 1px 6px; border-radius: 8px; background: rgba(123,147,255,.12); color: var(--accent); }

/* Badges */
.badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 11px; font-weight: 600; }
.badge-ok { background: rgba(74,222,128,.12); color: var(--green); }
.badge-warn { background: rgba(251,191,36,.12); color: var(--amber); }
.badge-err { background: rgba(248,113,113,.12); color: var(--red); }
.badge-info { background: rgba(34,211,238,.12); color: var(--cyan); }
.badge-muted { background: rgba(124,132,150,.12); color: var(--text-dim); }

/* Labels */
.label-grid { display: flex; flex-wrap: wrap; gap: 6px; }
.label-chip {
  padding: 4px 12px; border-radius: 16px; font-size: 11px;
  background: var(--surface-raised); color: var(--text-dim);
  border: 1px solid var(--border-subtle);
}
.label-chip-sm { padding: 1px 6px; border-radius: 4px; font-size: 10px; background: var(--surface-raised); color: var(--text-dim); }

/* Buttons */
.btn {
  padding: 7px 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-raised);
  color: var(--text-dim);
  font-family: inherit; font-size: 12px;
  cursor: pointer;
  transition: all .12s;
}
.btn:hover { border-color: var(--accent); color: var(--text); }
.btn-accent {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-glow);
}
.btn-accent:hover { background: var(--accent); color: var(--bg); }
.btn:disabled { opacity: .4; cursor: not-allowed; }
.btn-sm { padding: 5px 12px; font-size: 11px; }
.btn-icon { display: inline-flex; align-items: center; gap: 6px; }

/* Commands panel */
.cmd-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
.cmd-card {
  background: var(--surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  padding: 16px;
  display: flex; flex-direction: column; gap: 10px;
}
.cmd-name { font-weight: 600; color: var(--accent); font-size: 14px; display: flex; align-items: center; gap: 8px; }
.cmd-code { font-family: 'JetBrains Mono', monospace; font-size: 11px; color: var(--text-faint); }
.cmd-desc { font-size: 12px; color: var(--text-dim); line-height: 1.5; }
.cmd-actions { display: flex; gap: 8px; margin-top: auto; }
.cmd-result {
  margin-top: 8px; padding: 10px 12px;
  border-radius: 8px; font-size: 12px;
  max-height: 200px; overflow-y: auto;
  white-space: pre-wrap; word-break: break-word;
  display: none;
  font-family: 'JetBrains Mono', monospace;
}
.cmd-result.show { display: block; }
.cmd-result.success { background: rgba(74,222,128,.06); border: 1px solid rgba(74,222,128,.2); color: var(--green); }
.cmd-result.error { background: rgba(248,113,113,.06); border: 1px solid rgba(248,113,113,.2); color: var(--red); }
.cmd-result.loading { background: rgba(123,147,255,.06); border: 1px solid rgba(123,147,255,.2); color: var(--accent); }

/* Empty state */
.empty-state {
  padding: 48px 24px;
  text-align: center;
  color: var(--text-dim);
  background: var(--surface);
  border: 1px solid var(--border-subtle);
  border-radius: 12px;
}
.empty-icon { font-size: 28px; display: block; margin-bottom: 8px; color: var(--green); }

/* Issues */
.issues-banner { margin-bottom: 14px; }

/* Indicator */
.htmx-indicator { opacity: 0; transition: opacity .2s; }
.htmx-request .htmx-indicator, .htmx-request.htmx-indicator { opacity: 1; }
.live-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); display: inline-block; box-shadow: 0 0 6px var(--green); }
.live-dot.loading { background: var(--amber); box-shadow: 0 0 6px var(--amber); animation: pulse 1s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

/* Section header */
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; }
.section-title { font-size: 13px; font-weight: 600; text-transform: uppercase; letter-spacing: .6px; color: var(--text-dim); }


/* Quake Console */
.qconsole-overlay {
  position: fixed; top: 0; left: 0; right: 0;
  height: 50vh;
  background: rgba(10,12,16,.96);
  backdrop-filter: blur(12px);
  border-bottom: 2px solid var(--accent);
  box-shadow: 0 4px 32px rgba(0,0,0,.5);
  transform: translateY(-100%);
  transition: transform .25s cubic-bezier(.4,0,.2,1);
  z-index: 1000;
  display: flex; flex-direction: column;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
}
.qconsole-overlay.open { transform: translateY(0); }
.qconsole-header {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  display: flex; justify-content: space-between; align-items: center;
  font-size: 11px; color: var(--text-faint);
}
.qconsole-header span { color: var(--accent); font-weight: 600; }
.qconsole-output {
  flex: 1; overflow-y: auto; padding: 12px 16px;
  font-size: 12px; line-height: 1.6; color: var(--text-dim);
  white-space: pre-wrap; word-break: break-word;
}
.qconsole-output .q-ok { color: var(--green); }
.qconsole-output .q-err { color: var(--red); }
.qconsole-output .q-warn { color: var(--amber); }
.qconsole-output .q-info { color: var(--cyan); }
.qconsole-output .q-cmd { color: var(--accent); }
.qconsole-input-row {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 16px;
  border-top: 1px solid var(--border);
  background: rgba(15,17,23,.8);
}
.qconsole-prompt { color: var(--accent); font-size: 13px; font-weight: 700; }
.qconsole-input {
  flex: 1; background: transparent; border: none; outline: none;
  color: var(--text); font-family: inherit; font-size: 13px;
  caret-color: var(--accent);
}

/* Table sorting + filtering */
.data-table th.sortable { cursor: pointer; user-select: none; }
.data-table th.sortable:hover { color: var(--accent); }
.data-table th .sort-arrow { font-size: 9px; margin-left: 4px; opacity: .4; }
.data-table th.sort-asc .sort-arrow, .data-table th.sort-desc .sort-arrow { opacity: 1; color: var(--accent); }
.filter-bar {
  display: flex; gap: 10px; align-items: center; margin-bottom: 14px;
}
.filter-input {
  padding: 7px 14px;
  background: var(--surface);
  border: 1px solid var(--border-subtle);
  border-radius: 8px;
  color: var(--text);
  font-family: inherit; font-size: 12px;
  outline: none; flex: 1; max-width: 320px;
  transition: border-color .12s;
}
.filter-input:focus { border-color: var(--accent); }
.filter-input::placeholder { color: var(--text-faint); }

/* Collapsible repo groups */
.pr-group { margin-bottom: 8px; }
.pr-group-header {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--border-subtle);
  border-radius: 10px;
  cursor: pointer; user-select: none;
  transition: all .12s;
}
.pr-group-header:hover { border-color: var(--border); background: var(--surface-raised); }
.pr-group-header .chevron {
  font-size: 10px; color: var(--text-faint);
  transition: transform .2s;
  width: 14px; text-align: center;
}
.pr-group.open .pr-group-header .chevron { transform: rotate(90deg); }
.pr-group.open .pr-group-header { border-radius: 10px 10px 0 0; border-bottom-color: transparent; }
.pr-group-name { font-weight: 600; color: var(--accent); }
.pr-group-count { font-size: 11px; color: var(--text-faint); }
.pr-group-meta { margin-left: auto; display: flex; gap: 8px; font-size: 11px; }
.pr-group-body {
  display: none;
  border: 1px solid var(--border-subtle);
  border-top: none;
  border-radius: 0 0 10px 10px;
  overflow: hidden;
}
.pr-group.open .pr-group-body { display: block; }
.pr-group-body .data-table { border: none; border-radius: 0; }
.pr-group-body .data-table thead { display: none; }

/* Age column */
.age-new { color: var(--green); }
.age-mid { color: var(--amber); }
.age-old { color: var(--red); }
/* Scrollbar */
::-webkit-scrollbar { width: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

/* Responsive */
@media (max-width: 900px) {
  .sidebar { display: none; }
  .summary-grid { flex-direction: column; }
  .summary-right { grid-template-columns: repeat(2, 1fr); }
}
</style>
</head>
<body hx-ext="morph">
<div class="layout">

  <!-- Sidebar -->
  <nav class="sidebar">
    <div class="sidebar-brand">
      <div class="brand-name">temper</div>
      <div class="brand-sub">governance</div>
    </div>
    <div class="nav-section">Overview</div>
    <div class="nav-item active" onclick="switchPanel('overview')">
      <span class="nav-icon">&#9632;</span> Dashboard
    </div>
    <div class="nav-item" onclick="switchPanel('repos')">
      <span class="nav-icon">&#9776;</span> Repositories
      <span class="nav-badge" id="nav-repo-count">...</span>
    </div>
    <div class="nav-item" onclick="switchPanel('prs')">
      <span class="nav-icon">&#8693;</span> Pull Requests
      <span class="nav-badge" id="nav-pr-count">...</span>
    </div>
    <div class="nav-section">Configuration</div>
    <div class="nav-item" onclick="switchPanel('policy')">
      <span class="nav-icon">&#9670;</span> Policy
    </div>
    <div class="nav-item" onclick="switchPanel('issues')">
      <span class="nav-icon">&#9888;</span> Issues
    </div>
    <div class="nav-section">Actions</div>
    <div class="nav-item" onclick="switchPanel('commands')">
      <span class="nav-icon">&#9654;</span> Commands
    </div>
    <div class="sidebar-footer">
      <span class="live-dot htmx-indicator" id="poll-indicator"></span>
      <span id="last-updated" style="margin-left:6px"></span>
    </div>
  </nav>

  <!-- Main content -->
  <div class="main">
    <div class="main-header">
      <div class="page-title" id="panel-title">Dashboard</div>
      <div class="header-actions">
        <button class="btn btn-sm" onclick="runCmd('refresh','refresh-result')">Refresh</button>
      </div>
    </div>

    <div class="main-content">
      <!-- Overview panel -->
      <div id="panel-overview" class="panel active">
        <div id="summary-section"
             hx-get="/dashboard/partials/summary"
             hx-trigger="load, every 60s"
             hx-swap="morph:innerHTML"
             hx-indicator="#poll-indicator">
          <div class="empty-state">Loading...</div>
        </div>
        <div class="section-header" style="margin-top:24px">
          <div class="section-title">Recent Pull Requests</div>
        </div>
        <div id="overview-prs"
             hx-get="/dashboard/partials/prs"
             hx-trigger="load, every 60s"
             hx-swap="morph:innerHTML"
             hx-indicator="#poll-indicator">
          <div class="empty-state">Loading...</div>
        </div>
      </div>

      <!-- Repos panel -->
      <div id="panel-repos" class="panel">
        <div class="section-header">
          <div class="section-title">All Repositories</div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm btn-accent" onclick="runCmd('sync','sync-result')">Sync All Repos</button>
            <button class="btn btn-sm" onclick="runCmd('refresh','refresh-result2')">Refresh Cache</button>
          </div>
        </div>
        <div id="sync-result" class="cmd-result"></div>
        <div id="refresh-result2" class="cmd-result"></div>
        <div class="filter-bar"><input class="filter-input" data-table="repos-section" placeholder="Filter repositories..." /></div>
        <div id="repos-section"
             hx-get="/dashboard/partials/repos"
             hx-trigger="load, every 60s"
             hx-swap="morph:innerHTML"
             hx-indicator="#poll-indicator">
          <div class="empty-state">Loading...</div>
        </div>
      </div>

      <!-- PRs panel -->
      <div id="panel-prs" class="panel">
        <div class="section-header">
          <div class="section-title">Open Pull Requests</div>
        </div>
        <div class="filter-bar"><input class="filter-input" data-table="prs-section" placeholder="Filter pull requests..." /></div>
        <div id="prs-section"
             hx-get="/dashboard/partials/prs"
             hx-trigger="load, every 60s"
             hx-swap="morph:innerHTML"
             hx-indicator="#poll-indicator">
          <div class="empty-state">Loading...</div>
        </div>
      </div>

      <!-- Policy panel -->
      <div id="panel-policy" class="panel">
        <div class="section-header">
          <div class="section-title">Governance Policy</div>
        </div>
        <div id="policy-section"
             hx-get="/dashboard/partials/policy"
             hx-trigger="load, every 300s"
             hx-swap="morph:innerHTML"
             hx-indicator="#poll-indicator">
          <div class="empty-state">Loading...</div>
        </div>
      </div>

      <!-- Issues panel -->
      <div id="panel-issues" class="panel">
        <div class="section-header">
          <div class="section-title">Compliance Issues</div>
          <button class="btn btn-sm btn-accent" onclick="runCmd('sync','issues-sync-result')">Fix: Sync All</button>
        </div>
        <div id="issues-sync-result" class="cmd-result"></div>
        <div id="issues-section"
             hx-get="/dashboard/partials/issues"
             hx-trigger="load, every 60s"
             hx-swap="morph:innerHTML"
             hx-indicator="#poll-indicator">
          <div class="empty-state">Loading...</div>
        </div>
      </div>

      <!-- Commands panel -->
      <div id="panel-commands" class="panel">
        <div class="section-header">
          <div class="section-title">Governance Commands</div>
          <span class="text-dim">Same commands available via GitHub issue comments</span>
        </div>
        <div class="cmd-grid">
          <div class="cmd-card">
            <div class="cmd-name">Sync All Repositories <span class="cmd-code">/sync-all-repos</span></div>
            <div class="cmd-desc">Apply config.yml settings (merge strategy, branch protection, labels, dependabot) to all organization repositories.</div>
            <div class="cmd-actions"><button class="btn btn-accent btn-sm btn-icon" onclick="runCmd('sync','cmd-sync-result')">&#9654; Run</button></div>
            <div id="cmd-sync-result" class="cmd-result"></div>
          </div>
          <div class="cmd-card">
            <div class="cmd-name">Check Config <span class="cmd-code">/check-config</span></div>
            <div class="cmd-desc">Generate a configuration report comparing actual repo settings against the defined policy in config.yml.</div>
            <div class="cmd-actions"><button class="btn btn-accent btn-sm btn-icon" onclick="runCmd('check-config','cmd-config-result')">&#9654; Run</button></div>
            <div id="cmd-config-result" class="cmd-result"></div>
          </div>
          <div class="cmd-card">
            <div class="cmd-name">Check Dependabot <span class="cmd-code">/check-dependabot</span></div>
            <div class="cmd-desc">Audit Dependabot configuration across all repos. Checks for missing configs, wrong labels, and ecosystem coverage.</div>
            <div class="cmd-actions"><button class="btn btn-accent btn-sm btn-icon" onclick="runCmd('check-dependabot','cmd-depbot-result')">&#9654; Run</button></div>
            <div id="cmd-depbot-result" class="cmd-result"></div>
          </div>
          <div class="cmd-card">
            <div class="cmd-name">Fix Dependabot Labels <span class="cmd-code">/fix-dependabot-labels</span></div>
            <div class="cmd-desc">Automatically fix labels on Dependabot PRs that are missing the standard "dependencies" label.</div>
            <div class="cmd-actions"><button class="btn btn-accent btn-sm btn-icon" onclick="runCmd('fix-dependabot-labels','cmd-fixlbl-result')">&#9654; Run</button></div>
            <div id="cmd-fixlbl-result" class="cmd-result"></div>
          </div>
          <div class="cmd-card">
            <div class="cmd-name">Analyze Organization <span class="cmd-code">/analyze-org</span></div>
            <div class="cmd-desc">Generate a comprehensive organization analysis report covering all repos, CI, protections, and recommendations.</div>
            <div class="cmd-actions"><button class="btn btn-accent btn-sm btn-icon" onclick="runCmd('analyze-org','cmd-analyze-result')">&#9654; Run</button></div>
            <div id="cmd-analyze-result" class="cmd-result"></div>
          </div>
          <div class="cmd-card">
            <div class="cmd-name">Refresh Cache</div>
            <div class="cmd-desc">Invalidate the dashboard cache and re-fetch all data from GitHub API. Use after making manual changes.</div>
            <div class="cmd-actions"><button class="btn btn-sm btn-icon" onclick="runCmd('refresh','cmd-refresh-result')">&#9654; Run</button></div>
            <div id="cmd-refresh-result" class="cmd-result"></div>
          </div>
        </div>
      </div>

    </div>
  
  <!-- Quake Console -->
  <div class="qconsole-overlay" id="qconsole">
    <div class="qconsole-header">
      <div><span>temper</span> console</div>
      <div>Press <code>&#96;</code> to toggle &middot; Type <code>help</code> for commands</div>
    </div>
    <div class="qconsole-output" id="qconsole-output"></div>
    <div class="qconsole-input-row">
      <span class="qconsole-prompt">&gt;</span>
      <input class="qconsole-input" id="qconsole-input" type="text" autocomplete="off" spellcheck="false" placeholder="Enter command..." />
    </div>
  </div>
</div>
</div>

<script>
var panels = ['overview','repos','prs','policy','issues','commands'];
var titles = {overview:'Dashboard',repos:'Repositories',prs:'Pull Requests',policy:'Governance Policy',issues:'Compliance Issues',commands:'Commands'};
function switchPanel(name) {
  panels.forEach(function(p) {
    var el = document.getElementById('panel-' + p);
    if (el) el.style.display = p === name ? 'block' : 'none';
  });
  document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
  var items = document.querySelectorAll('.nav-item');
  for (var i = 0; i < items.length; i++) {
    if (items[i].getAttribute('onclick') && items[i].getAttribute('onclick').indexOf(name) !== -1) items[i].classList.add('active');
  }
  document.getElementById('panel-title').textContent = titles[name] || name;
}
// Init: hide all panels except overview
panels.forEach(function(p) {
  var el = document.getElementById('panel-' + p);
  if (el) el.style.display = p === 'overview' ? 'block' : 'none';
});

var cmdMap = {
  'sync': { url: '/dashboard/actions/sync', method: 'POST' },
  'refresh': { url: '/dashboard/actions/refresh', method: 'POST' },
  'check-config': { url: '/dashboard/actions/check-config', method: 'POST' },
  'check-dependabot': { url: '/dashboard/actions/check-dependabot', method: 'POST' },
  'fix-dependabot-labels': { url: '/dashboard/actions/fix-dependabot-labels', method: 'POST' },
  'analyze-org': { url: '/dashboard/actions/analyze-org', method: 'POST' },
};

function runCmd(cmd, resultId) {
  var el = document.getElementById(resultId);
  if (!el) return;
  el.textContent = 'Running...';
  el.className = 'cmd-result show loading';
  var info = cmdMap[cmd];
  if (!info) { el.textContent = 'Unknown command'; el.className = 'cmd-result show error'; return; }
  fetch(info.url, { method: info.method })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      el.textContent = d.message || d.report || JSON.stringify(d, null, 2);
      el.className = 'cmd-result show ' + (d.success ? 'success' : 'error');
      if (d.success && (cmd === 'sync' || cmd === 'refresh')) {
        setTimeout(function() {
          htmx.trigger(document.getElementById('summary-section'), 'load');
          htmx.trigger(document.getElementById('repos-section'), 'load');
          htmx.trigger(document.getElementById('issues-section'), 'load');
        }, 500);
      }
    })
    .catch(function(e) { el.textContent = 'Error: ' + e.message; el.className = 'cmd-result show error'; });
}

// Update sidebar badges from summary data
document.body.addEventListener('htmx:afterSwap', function(e) {
  if (e.detail.target.id === 'summary-section') {
    var cards = e.detail.target.querySelectorAll('.metric-value');
    if (cards.length >= 1) {
      var repoEl = document.getElementById('nav-repo-count');
      if (repoEl && cards[0]) repoEl.textContent = cards[0].textContent;
    }
    // update PR count badge
    if (cards.length >= 8) {
      var prEl = document.getElementById('nav-pr-count');
      if (prEl && cards[7]) prEl.textContent = cards[7].textContent;
    }
  }
});

// ── Quake Console ──────────────────────────────────
var qOpen = false;
var qHistory = [];
var qHistIdx = -1;

// Safe HTML escaping for console output - prevents XSS
function esc4q(s) { return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

function qLog(text, cls) {
  var out = document.getElementById("qconsole-output");
  var line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

function qLogStyled(cls, text) {
  var out = document.getElementById("qconsole-output");
  var span = document.createElement("span");
  span.className = cls;
  span.textContent = text;
  out.appendChild(span);
  out.appendChild(document.createTextNode("\n"));
  out.scrollTop = out.scrollHeight;
}

// Init message
(function() {
  qLogStyled("q-info", "Temper Governance Console v1.0");
  qLogStyled("q-info", 'Type "help" for available commands.');
})();

function showHelp() {
  var lines = [
    ["sync", "Sync all repos to config"],
    ["refresh", "Refresh dashboard cache"],
    ["check-config", "Run config check report"],
    ["check-deps", "Check dependabot configs"],
    ["fix-labels", "Fix dependabot PR labels"],
    ["analyze", "Full org analysis"],
    ["status", "Show compliance summary"],
    ["prs", "Show open pull requests"],
    ["clear", "Clear console"],
    ["help", "Show this help"],
  ];
  qLogStyled("q-info", "Available commands:");
  lines.forEach(function(l) {
    var out = document.getElementById("qconsole-output");
    var div = document.createElement("div");
    var cmd = document.createElement("span");
    cmd.className = "q-cmd";
    cmd.textContent = "  " + l[0].padEnd(16);
    div.appendChild(cmd);
    div.appendChild(document.createTextNode(l[1]));
    out.appendChild(div);
  });
  document.getElementById("qconsole-output").scrollTop = 999999;
}

function runQCmd(cmd) {
  if (cmd === "status") {
    qLogStyled("q-warn", "Fetching status...");
    fetch("/api/org/health").then(function(r){return r.json()}).then(function(d) {
      var score = Math.round(((d.withProtection+d.correctMerge+d.withSigned+d.withAutoMerge+d.withAllLabels)/(d.total*5))*100);
      qLogStyled("q-ok", "Compliance: " + score + "%");
      qLog("Repos: " + d.total + "  Protected: " + d.withProtection + "  Signed: " + d.withSigned);
      qLog("CI: " + d.ciPassing + "/" + d.withCI + " passing  Merge OK: " + d.correctMerge + "  Auto: " + d.withAutoMerge);
      qLog("Open PRs: " + (d.totalPRs || 0) + "  Issues: " + (d.issues ? d.issues.length : 0));
    }).catch(function(e) { qLogStyled("q-err", "Error: " + e.message); });
    return;
  }
  if (cmd === "prs") {
    qLogStyled("q-warn", "Fetching PRs...");
    fetch("/api/org/repos").then(function(r){return r.json()}).then(function(d) {
      var prs = [];
      (d.repos||[]).forEach(function(r) { (r.open_prs||[]).forEach(function(p) { prs.push(r.name + " #" + p.number + " " + p.title); }); });
      if (prs.length === 0) qLogStyled("q-ok", "No open PRs");
      else prs.forEach(function(p) { qLog("  " + p); });
    }).catch(function(e) { qLogStyled("q-err", "Error: " + e.message); });
    return;
  }
  var urlMap = { sync:"/dashboard/actions/sync", refresh:"/dashboard/actions/refresh",
    "check-config":"/dashboard/actions/check-config", "check-dependabot":"/dashboard/actions/check-dependabot",
    "fix-dependabot-labels":"/dashboard/actions/fix-dependabot-labels", "analyze-org":"/dashboard/actions/analyze-org" };
  var url = urlMap[cmd];
  if (!url) { qLogStyled("q-err", "Unknown command"); return; }
  qLogStyled("q-warn", "Running " + cmd + "...");
  fetch(url, {method:"POST"}).then(function(r){return r.json()}).then(function(d) {
    var msg = d.message || JSON.stringify(d);
    if (msg.length > 2000) msg = msg.substring(0,2000) + "\n... (truncated)";
    qLogStyled(d.success ? "q-ok" : "q-err", msg);
  }).catch(function(e) { qLogStyled("q-err", "Error: " + e.message); });
}

var qCmdMap = {
  help: function() { showHelp(); },
  clear: function() { document.getElementById("qconsole-output").textContent = ""; },
  status: function() { runQCmd("status"); },
  prs: function() { runQCmd("prs"); },
  sync: function() { runQCmd("sync"); },
  refresh: function() { runQCmd("refresh"); },
  "check-config": function() { runQCmd("check-config"); },
  "check-deps": function() { runQCmd("check-dependabot"); },
  "fix-labels": function() { runQCmd("fix-dependabot-labels"); },
  analyze: function() { runQCmd("analyze-org"); },
};

document.addEventListener("keydown", function(e) {
  if (e.key === "\`" && !e.ctrlKey && !e.metaKey) {
    if (document.activeElement === document.getElementById("qconsole-input")) return;
    e.preventDefault();
    qOpen = !qOpen;
    document.getElementById("qconsole").classList.toggle("open", qOpen);
    if (qOpen) document.getElementById("qconsole-input").focus();
  }
  if (e.key === "Escape" && qOpen) {
    qOpen = false;
    document.getElementById("qconsole").classList.remove("open");
  }
});

document.getElementById("qconsole-input").addEventListener("keydown", function(e) {
  if (e.key === "\`") { e.preventDefault(); qOpen = false; document.getElementById("qconsole").classList.remove("open"); return; }
  if (e.key === "Enter") {
    var val = e.target.value.trim();
    if (!val) return;
    qHistory.unshift(val);
    qHistIdx = -1;
    qLogStyled("q-cmd", "> " + val);
    var fn = qCmdMap[val];
    if (fn) fn();
    else qLogStyled("q-err", "Unknown command: " + val + ". Type help for available commands.");
    e.target.value = "";
  }
  if (e.key === "ArrowUp") { e.preventDefault(); if (qHistIdx < qHistory.length-1) { qHistIdx++; e.target.value = qHistory[qHistIdx]; } }
  if (e.key === "ArrowDown") { e.preventDefault(); if (qHistIdx > 0) { qHistIdx--; e.target.value = qHistory[qHistIdx]; } else { qHistIdx = -1; e.target.value = ""; } }
});

// ── Table Sorting ──────────────────────────────────
document.body.addEventListener("click", function(e) {
  var th = e.target.closest("th.sortable");
  if (!th) return;
  var table = th.closest("table");
  var idx = Array.from(th.parentElement.children).indexOf(th);
  var tbody = table.querySelector("tbody");
  if (!tbody) return;
  var rows = Array.from(tbody.querySelectorAll("tr"));
  var asc = !th.classList.contains("sort-asc");
  th.parentElement.querySelectorAll("th").forEach(function(h) { h.classList.remove("sort-asc","sort-desc"); });
  th.classList.add(asc ? "sort-asc" : "sort-desc");
  rows.sort(function(a, b) {
    var at = (a.children[idx]||{}).textContent || "";
    var bt = (b.children[idx]||{}).textContent || "";
    var cmp = at.localeCompare(bt, undefined, {numeric: true});
    return asc ? cmp : -cmp;
  });
  rows.forEach(function(r) { tbody.appendChild(r); });
});


// Auto-expand PR groups with failures
document.body.addEventListener("htmx:afterSwap", function(e) {
  if (e.detail.target.id === "prs-section" || e.detail.target.id === "overview-prs") {
    e.detail.target.querySelectorAll(".pr-group").forEach(function(g) {
      if (g.querySelector(".badge-err")) g.classList.add("open");
    });
  }
});
// ── Table Filtering ──────────────────────────────────
document.body.addEventListener("input", function(e) {
  if (!e.target.classList.contains("filter-input")) return;
  var query = e.target.value.toLowerCase();
  var tableId = e.target.getAttribute("data-table");
  var section = document.getElementById(tableId);
  if (!section) return;
  var tbody = section.querySelector("tbody");
  if (!tbody) return;
  Array.from(tbody.querySelectorAll("tr")).forEach(function(row) {
    row.style.display = row.textContent.toLowerCase().indexOf(query) !== -1 ? "" : "none";
  });
});
</script>
</body>
</html>`;
}

// ── Request handler ──────────────────────────────────────────────────
function sendHtml(res, s, html) { res.writeHead(s, {'Content-Type':'text/html; charset=utf-8'}); res.end(html); }
function sendJson(res, s, obj) { res.writeHead(s, {'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); }
function redirect(res, loc) { res.writeHead(302, {'Location':loc}); res.end(); }

export function createDashboardHandler() {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '')) { redirect(res, '/dashboard'); return true; }
    if (req.method === 'GET' && path === '/dashboard') { sendHtml(res, 200, renderDashboardPage()); return true; }

    // Partials
    if (req.method === 'GET' && path === '/dashboard/partials/summary') {
      try { sendHtml(res, 200, renderSummaryPartial(await fetchOrgData())); }
      catch (err) { getLogger().error({err},'Dashboard summary error'); sendHtml(res, 500, '<div class="badge badge-err">Error loading</div>'); }
      return true;
    }
    if (req.method === 'GET' && path === '/dashboard/partials/repos') {
      try { sendHtml(res, 200, renderReposPartial(await fetchOrgData())); }
      catch (err) { getLogger().error({err},'Dashboard repos error'); sendHtml(res, 500, '<div class="badge badge-err">Error loading</div>'); }
      return true;
    }
    if (req.method === 'GET' && path === '/dashboard/partials/prs') {
      try { sendHtml(res, 200, renderPRsPartial(await fetchOrgData())); }
      catch (err) { getLogger().error({err},'Dashboard PRs error'); sendHtml(res, 500, '<div class="badge badge-err">Error loading</div>'); }
      return true;
    }
    if (req.method === 'GET' && path === '/dashboard/partials/policy') {
      try { sendHtml(res, 200, renderPolicyPartial(await fetchOrgData())); }
      catch (err) { getLogger().error({err},'Dashboard policy error'); sendHtml(res, 500, '<div class="badge badge-err">Error loading</div>'); }
      return true;
    }
    if (req.method === 'GET' && path === '/dashboard/partials/issues') {
      try { sendHtml(res, 200, renderIssuesPartial(await fetchOrgData())); }
      catch (err) { getLogger().error({err},'Dashboard issues error'); sendHtml(res, 500, '<div class="badge badge-err">Error loading</div>'); }
      return true;
    }

    // JSON APIs
    if (req.method === 'GET' && path === '/api/org/health') {
      try { const d = await fetchOrgData(); sendJson(res, 200, {success:true, ...d.summary, timestamp:d.timestamp}); }
      catch (err) { sendJson(res, 500, {success:false, error:err.message}); }
      return true;
    }
    if (req.method === 'GET' && path === '/api/org/repos') {
      try { const d = await fetchOrgData(); sendJson(res, 200, {success:true, repos:d.repos}); }
      catch (err) { sendJson(res, 500, {success:false, error:err.message}); }
      return true;
    }

    // Action endpoints
    if (req.method === 'POST' && path === '/dashboard/actions/refresh') {
      invalidateCache();
      try { await fetchOrgData(); sendJson(res, 200, {success:true, message:'Cache refreshed successfully.'}); }
      catch (err) { sendJson(res, 500, {success:false, message:err.message}); }
      return true;
    }
    if (req.method === 'POST' && path === '/dashboard/actions/sync') {
      try {
        const octokit = await getOctokit();
        const org = getConfig()?.organization || 'pulseengine';
        const result = await synchronizeAllRepositories(octokit, org);
        invalidateCache();
        sendJson(res, 200, {success:result.success, message: result.success ? `Synchronized ${result.repositoriesProcessed} repositories successfully.` : result.error});
      } catch (err) { sendJson(res, 500, {success:false, message:err.message}); }
      return true;
    }
    if (req.method === 'POST' && path === '/dashboard/actions/check-config') {
      try {
        const octokit = await getOctokit();
        const org = getConfig()?.organization || 'pulseengine';
        const report = await generateConfigurationReport(octokit, org, org);
        sendJson(res, 200, {success:true, message: report});
      } catch (err) { sendJson(res, 500, {success:false, message:err.message}); }
      return true;
    }
    if (req.method === 'POST' && path === '/dashboard/actions/check-dependabot') {
      try {
        const octokit = await getOctokit();
        const org = getConfig()?.organization || 'pulseengine';
        // Check across all repos
        const data = await fetchOrgData();
        const results = [];
        for (const repo of data.repos) {
          const report = await checkDependabotConfiguration(octokit, org, repo.name);
          results.push(`## ${repo.name}\n${report}`);
        }
        sendJson(res, 200, {success:true, message: results.join('\n\n')});
      } catch (err) { sendJson(res, 500, {success:false, message:err.message}); }
      return true;
    }
    if (req.method === 'POST' && path === '/dashboard/actions/fix-dependabot-labels') {
      try {
        const octokit = await getOctokit();
        const org = getConfig()?.organization || 'pulseengine';
        const data = await fetchOrgData();
        let totalFixed = 0;
        for (const repo of data.repos) {
          const check = await checkExistingDependabotConfig(octokit, org, repo.name);
          if (check.labelIssues?.length > 0) {
            const fix = await fixDependabotPRLabels(octokit, org, repo.name, check.labelIssues);
            totalFixed += fix.fixedIssues || 0;
          }
        }
        sendJson(res, 200, {success:true, message: totalFixed > 0 ? `Fixed labels on ${totalFixed} Dependabot PRs.` : 'No Dependabot label issues found.'});
      } catch (err) { sendJson(res, 500, {success:false, message:err.message}); }
      return true;
    }
    if (req.method === 'POST' && path === '/dashboard/actions/analyze-org') {
      try {
        const octokit = await getOctokit();
        const org = getConfig()?.organization || 'pulseengine';
        const report = await generateOrganizationAnalysisReport(octokit, org);
        sendJson(res, 200, {success:true, message: report});
      } catch (err) { sendJson(res, 500, {success:false, message:err.message}); }
      return true;
    }

    return false;
  };
}
