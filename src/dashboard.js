import { getConfig } from './config.js';
import { getLogger } from './logger.js';
import { analyzeOrganizationRepositories, synchronizeAllRepositories } from './organization.js';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

// ── Cache ────────────────────────────────────────────────────────────
const cache = { data: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000;

function isCacheValid() {
  return cache.data && (Date.now() - cache.timestamp) < CACHE_TTL;
}

export function invalidateCache() {
  cache.data = null;
  cache.timestamp = 0;
}

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

// ── Data ─────────────────────────────────────────────────────────────
async function fetchOrgData() {
  if (isCacheValid()) return cache.data;

  const octokit = await getOctokit();
  const config = getConfig();
  const org = config?.organization || 'pulseengine';

  const analysis = await analyzeOrganizationRepositories(octokit, org);
  if (!analysis.success) throw new Error(analysis.error);

  const repos = analysis.repositories;

  for (const repo of repos) {
    // CI status
    try {
      const { data: runs } = await octokit.actions.listWorkflowRunsForRepo({ owner: org, repo: repo.name, per_page: 1 });
      const run = runs.workflow_runs?.[0];
      repo.ci_status = run ? { status: run.conclusion || run.status, updated_at: run.updated_at } : { status: 'none' };
    } catch { repo.ci_status = { status: 'none' }; }

    // Signed commits + auto-merge (need separate API calls)
    try {
      const { data: repoData } = await octokit.repos.get({ owner: org, repo: repo.name });
      repo.auto_merge_enabled = repoData.allow_auto_merge || false;
    } catch { repo.auto_merge_enabled = false; }

    try {
      await octokit.repos.getCommitSignatureProtection({
        owner: org, repo: repo.name, branch: repo.configurations?.default_branch || 'main'
      });
      repo.signed_commits_required = true;
    } catch { repo.signed_commits_required = false; }
  }

  const result = {
    org,
    config,
    timestamp: new Date().toISOString(),
    repos: repos.sort((a, b) => a.name.localeCompare(b.name)),
    summary: buildSummary(repos, config)
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

  const issues = [];
  repos.forEach(r => {
    if (!r.configurations?.branch_protection?.exists) issues.push({ repo: r.name, type: 'protection', msg: 'No branch protection' });
    const m = r.configurations?.merge_settings;
    if (m && ((!!m.allow_merge_commit !== !!targetMerge.allow_merge_commit) ||
              (!!m.allow_squash_merge !== !!targetMerge.allow_squash_merge) ||
              (!!m.allow_rebase_merge !== !!targetMerge.allow_rebase_merge))) {
      issues.push({ repo: r.name, type: 'merge', msg: 'Merge settings drift' });
    }
    if (!r.signed_commits_required) issues.push({ repo: r.name, type: 'signed', msg: 'Signed commits not required' });
    if (!r.auto_merge_enabled) issues.push({ repo: r.name, type: 'auto-merge', msg: 'Auto-merge not enabled' });
    if ((r.configurations?.labels?.standard_labels?.length || 0) < targetLabels) {
      issues.push({ repo: r.name, type: 'labels', msg: `Missing ${targetLabels - (r.configurations?.labels?.standard_labels?.length || 0)} labels` });
    }
  });

  return { total, withProtection, withCI, ciPassing, withSigned, withAutoMerge, correctMerge, withAllLabels, targetLabels, issues };
}

// ── Rendering helpers ────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function badge(cls, label) { return `<span class="badge ${cls}">${esc(label)}</span>`; }
function okBadge(ok, yesLabel, noLabel) { return ok ? badge('badge-ok', yesLabel || 'yes') : badge('badge-warn', noLabel || 'no'); }

function ciBadge(status) {
  const map = { success: ['badge-ok','pass'], failure: ['badge-err','fail'], cancelled: ['badge-warn','cancelled'],
    in_progress: ['badge-info','running'], queued: ['badge-info','queued'], none: ['badge-muted','none'] };
  const [cls, label] = map[status] || ['badge-muted', status || '?'];
  return badge(cls, label);
}

function mergeLabel(settings) {
  if (!settings || settings.error) return badge('badge-muted', '?');
  const parts = [];
  if (settings.allow_merge_commit) parts.push('merge');
  if (settings.allow_squash_merge) parts.push('squash');
  if (settings.allow_rebase_merge) parts.push('rebase');
  return badge(parts.length <= 2 ? 'badge-ok' : 'badge-warn', parts.join('+') || 'none');
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function pct(n, total) { return total === 0 ? 0 : Math.round(n / total * 100); }

// ── Partials ─────────────────────────────────────────────────────────
function renderSummaryPartial(data) {
  const s = data.summary;
  const t = s.total;
  function card(value, label, cls) {
    return `<div class="card ${cls}"><div class="card-value">${value}</div><div class="card-label">${label}</div></div>`;
  }
  const score = t === 0 ? 0 : Math.round(((s.withProtection + s.correctMerge + s.withSigned + s.withAutoMerge + s.withAllLabels) / (t * 5)) * 100);
  const scoreCls = score >= 90 ? 'card-ok' : score >= 70 ? 'card-warn' : 'card-err';

  return `<div class="cards">
    ${card(score + '%', 'Compliance', scoreCls)}
    ${card(t, 'Total Repos', '')}
    ${card(s.withProtection, 'Protected', s.withProtection === t ? 'card-ok' : 'card-warn')}
    ${card(s.ciPassing + '/' + s.withCI, 'CI Pass/Total', s.ciPassing === t ? 'card-ok' : s.withCI > 0 ? 'card-warn' : 'card-err')}
    ${card(s.withSigned, 'Signed', s.withSigned === t ? 'card-ok' : 'card-warn')}
    ${card(s.correctMerge, 'Correct Merge', s.correctMerge === t ? 'card-ok' : 'card-warn')}
    ${card(s.withAutoMerge, 'Auto-Merge', s.withAutoMerge === t ? 'card-ok' : 'card-warn')}
    ${card(s.withAllLabels, 'Labels OK', s.withAllLabels === t ? 'card-ok' : 'card-warn')}
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
    return `<tr><td class="policy-label">${esc(label)}</td><td>${value}</td>${detail ? `<td class="text-muted">${esc(detail)}</td>` : '<td></td>'}</tr>`;
  }

  return `<div class="policy-grid">
    <div class="policy-card">
      <h3>Merge Strategy</h3>
      <table class="policy-table">
        ${row('Merge commit', okBadge(merge.allow_merge_commit, 'allowed', 'blocked'), 'Preserves commit signatures')}
        ${row('Squash merge', okBadge(merge.allow_squash_merge, 'allowed', 'blocked'), 'GitHub signs squash commits')}
        ${row('Rebase merge', merge.allow_rebase_merge ? badge('badge-warn', 'allowed') : badge('badge-ok', 'blocked'), 'Cannot be signed by GitHub')}
        ${row('Delete branch', okBadge(merge.delete_branch_on_merge), '')}
        ${row('Auto-merge', okBadge(merge.allow_auto_merge), '')}
      </table>
    </div>
    <div class="policy-card">
      <h3>Branch Protection</h3>
      <table class="policy-table">
        ${row('Enforce admins', bp.enforce_admins ? badge('badge-warn', 'yes') : badge('badge-ok', 'no'), bp.enforce_admins ? 'Admins subject to rules' : 'Admin can bypass')}
        ${row('PR reviews', bp.required_pull_request_reviews === null ? badge('badge-ok', 'none') : badge('badge-warn', JSON.stringify(bp.required_pull_request_reviews)), '')}
        ${row('Signed commits', okBadge(bp.require_signed_commits, 'required', 'not required'), '')}
        ${row('Linear history', okBadge(bp.required_linear_history, 'required', 'not required'), '')}
        ${row('Force pushes', bp.allow_force_pushes ? badge('badge-err', 'allowed') : badge('badge-ok', 'blocked'), '')}
        ${row('Deletions', bp.allow_deletions ? badge('badge-err', 'allowed') : badge('badge-ok', 'blocked'), '')}
        ${row('Status checks', checks.length > 0 ? badge('badge-info', checks.join(', ')) : badge('badge-muted', 'none configured'), '')}
      </table>
    </div>
    <div class="policy-card">
      <h3>Auto-Merge Rules</h3>
      <table class="policy-table">
        ${row('Enabled', okBadge(am.enabled), '')}
        ${row('Dependabot PRs', okBadge(am.on_dependabot), '')}
        ${row('Bot users', (am.on_bot_users || []).length > 0 ? badge('badge-info', (am.on_bot_users || []).join(', ')) : badge('badge-muted', 'none'), '')}
        ${row('Method', badge('badge-info', am.merge_method || 'squash'), '')}
      </table>
    </div>
    <div class="policy-card">
      <h3>Standard Labels (${labels.length})</h3>
      <div class="label-list">${labels.map(l => `<span class="label-chip">${esc(l)}</span>`).join(' ')}</div>
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

    return `<tr>
      <td class="repo-name"><a href="https://github.com/${esc(data.org)}/${esc(r.name)}" target="_blank">${esc(r.name)}</a></td>
      <td>${okBadge(bp.exists)}</td>
      <td>${okBadge(r.signed_commits_required)}</td>
      <td>${ciBadge(r.ci_status?.status)}</td>
      <td>${mergeLabel(ms)}</td>
      <td>${okBadge(r.auto_merge_enabled)}</td>
      <td>${okBadge(dep.exists)}</td>
      <td>${hasAllLabels ? badge('badge-ok', lbls.standard_labels?.length + '/' + targetLabels) : badge('badge-warn', (lbls.standard_labels?.length || 0) + '/' + targetLabels)}</td>
      <td class="text-muted">${esc(timeAgo(r.updated_at))}</td>
    </tr>`;
  }).join('');

  return `<table class="repo-table">
    <thead><tr>
      <th>Repository</th><th>Protected</th><th>Signed</th><th>CI</th>
      <th>Merge</th><th>Auto</th><th>Dependabot</th><th>Labels</th><th>Updated</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderIssuesPartial(data) {
  const issues = data.summary.issues;
  if (issues.length === 0) {
    return `<div class="empty-state">${badge('badge-ok', 'All repos compliant')} No issues detected.</div>`;
  }

  // Group by repo
  const byRepo = {};
  issues.forEach(i => {
    if (!byRepo[i.repo]) byRepo[i.repo] = [];
    byRepo[i.repo].push(i);
  });

  const typeIcon = { protection: 'shield', merge: 'git-merge', signed: 'key', 'auto-merge': 'zap', labels: 'tag' };
  const rows = Object.entries(byRepo).map(([repo, items]) => {
    const badges = items.map(i => {
      const cls = i.type === 'protection' ? 'badge-err' : 'badge-warn';
      return badge(cls, i.msg);
    }).join(' ');
    return `<tr><td class="repo-name">${esc(repo)}</td><td>${badges}</td></tr>`;
  }).join('');

  return `<div class="issues-header">${badge('badge-err', issues.length + ' issues')} across ${Object.keys(byRepo).length} repos</div>
    <table class="repo-table">
      <thead><tr><th>Repository</th><th>Issues</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="issues-hint">Run <code>Sync All Repos</code> to apply config to drifted repos.</div>`;
}

// ── Main page ────────────────────────────────────────────────────────
function renderDashboardPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Temper — Governance Dashboard</title>
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
<script src="https://unpkg.com/idiomorph@0.3.0/dist/idiomorph-ext.min.js"></script>
<style>
:root{--bg:#0f1117;--surface:#1a1d27;--surface-raised:#242836;--border:#2e3345;--text:#e1e4ed;--text-muted:#8b90a0;--accent:#6c8cff;--accent-dim:#4a5a8a;--green:#4ade80;--red:#f87171;--amber:#fbbf24;--cyan:#22d3ee}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:ui-monospace,'Cascadia Code','Fira Code',monospace;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code{background:var(--surface-raised);padding:2px 6px;border-radius:4px;font-size:12px}
.container{max-width:1280px;margin:0 auto;padding:24px}

/* Header */
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid var(--border)}
header h1{font-size:20px;color:var(--accent)}
.header-right{display:flex;align-items:center;gap:12px}
.poll-dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green)}
.htmx-indicator{opacity:0;transition:opacity 200ms}
.htmx-request .htmx-indicator,.htmx-request.htmx-indicator{opacity:1}

/* Tabs */
.tabs{display:flex;gap:0;margin-bottom:24px;border-bottom:1px solid var(--border)}
.tab{padding:10px 20px;font-size:13px;color:var(--text-muted);cursor:pointer;border-bottom:2px solid transparent;transition:all .15s;background:none;border-top:none;border-left:none;border-right:none;font-family:inherit}
.tab:hover{color:var(--text)}
.tab.active{color:var(--accent);border-bottom-color:var(--accent)}
.tab-panel{display:none}.tab-panel.active{display:block}

/* Cards */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 10px;text-align:center}
.card-ok{border-color:rgba(74,222,128,.3)}.card-warn{border-color:rgba(251,191,36,.3)}.card-err{border-color:rgba(248,113,113,.3)}
.card-value{font-size:24px;font-weight:700}.card-ok .card-value{color:var(--green)}.card-warn .card-value{color:var(--amber)}.card-err .card-value{color:var(--red)}
.card-label{font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-top:4px}

/* Section */
.section{margin-bottom:24px}
.section h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:12px}

/* Table */
.repo-table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.repo-table th{text-align:left;padding:8px 12px;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);background:var(--surface-raised);border-bottom:1px solid var(--border)}
.repo-table td{padding:6px 12px;border-bottom:1px solid var(--border);transition:background .15s}
.repo-table tr:last-child td{border-bottom:none}
.repo-table tr:hover td{background:var(--surface-raised)}
.repo-name{font-weight:600;color:var(--accent)}
.text-muted{color:var(--text-muted);font-size:12px}

/* Badges */
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
.badge-ok{background:rgba(74,222,128,.15);color:var(--green)}
.badge-warn{background:rgba(251,191,36,.15);color:var(--amber)}
.badge-err{background:rgba(248,113,113,.15);color:var(--red)}
.badge-info{background:rgba(34,211,238,.15);color:var(--cyan)}
.badge-muted{background:rgba(139,144,160,.15);color:var(--text-muted)}

/* Policy grid */
.policy-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
.policy-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px}
.policy-card h3{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:12px}
.policy-table{width:100%;border-collapse:collapse}
.policy-table td{padding:5px 0;border-bottom:1px solid rgba(46,51,69,.5);font-size:13px}
.policy-table tr:last-child td{border-bottom:none}
.policy-label{color:var(--text);min-width:120px}

/* Labels */
.label-list{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.label-chip{padding:3px 10px;border-radius:12px;font-size:11px;background:var(--surface-raised);color:var(--text-muted);border:1px solid var(--border)}

/* Actions */
.actions{display:flex;gap:8px;margin-bottom:16px}
.btn{padding:6px 14px;border:1px solid var(--border);border-radius:6px;background:var(--surface-raised);color:var(--text);font-family:inherit;font-size:12px;cursor:pointer;transition:all .15s}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn-primary{border-color:var(--accent);color:var(--accent)}.btn-primary:hover{background:var(--accent);color:var(--bg)}
#action-result{margin-bottom:12px;padding:8px 12px;border-radius:6px;font-size:12px;display:none}
#action-result.show{display:block}
#action-result.success{background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.3);color:var(--green)}
#action-result.error{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3);color:var(--red)}

/* Issues */
.issues-header{margin-bottom:12px}
.issues-hint{margin-top:12px;font-size:12px;color:var(--text-muted)}
.empty-state{padding:24px;text-align:center;color:var(--text-muted)}

/* Cache info */
.cache-info{font-size:11px;color:var(--text-muted)}

/* Scrollbar */
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body hx-ext="morph">
<div class="container">
  <header>
    <h1>temper</h1>
    <div class="header-right">
      <span class="poll-dot htmx-indicator" id="poll-indicator"></span>
      <span class="cache-info" id="cache-ts"></span>
      <span class="text-muted">governance dashboard</span>
    </div>
  </header>

  <div id="summary-section"
       hx-get="/dashboard/partials/summary"
       hx-trigger="load, every 60s"
       hx-swap="morph:innerHTML"
       hx-indicator="#poll-indicator"></div>

  <div class="tabs" id="tab-bar">
    <button class="tab active" onclick="switchTab('repos')">Repositories</button>
    <button class="tab" onclick="switchTab('policy')">Policy Config</button>
    <button class="tab" onclick="switchTab('issues')">Issues</button>
  </div>

  <div id="panel-repos" class="tab-panel active">
    <div class="section">
      <div class="actions">
        <button class="btn btn-primary" onclick="dashAction('/dashboard/actions/sync')">Sync All Repos</button>
        <button class="btn" onclick="dashAction('/dashboard/actions/refresh')">Refresh Cache</button>
      </div>
      <div id="action-result"></div>
    </div>
    <div id="repos-section"
         hx-get="/dashboard/partials/repos"
         hx-trigger="load, every 60s"
         hx-swap="morph:innerHTML"
         hx-indicator="#poll-indicator"></div>
  </div>

  <div id="panel-policy" class="tab-panel">
    <div id="policy-section"
         hx-get="/dashboard/partials/policy"
         hx-trigger="load, every 300s"
         hx-swap="morph:innerHTML"
         hx-indicator="#poll-indicator"></div>
  </div>

  <div id="panel-issues" class="tab-panel">
    <div id="issues-section"
         hx-get="/dashboard/partials/issues"
         hx-trigger="load, every 60s"
         hx-swap="morph:innerHTML"
         hx-indicator="#poll-indicator"></div>
  </div>
</div>

<script>
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
  document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('panel-' + name).classList.add('active');
  var tabs = document.querySelectorAll('.tab');
  for (var i = 0; i < tabs.length; i++) {
    if (tabs[i].textContent.toLowerCase().indexOf(name) !== -1 || 
        (name === 'repos' && tabs[i].textContent === 'Repositories') ||
        (name === 'policy' && tabs[i].textContent === 'Policy Config') ||
        (name === 'issues' && tabs[i].textContent === 'Issues')) {
      tabs[i].classList.add('active');
    }
  }
}
function dashAction(url) {
  var el = document.getElementById('action-result');
  el.className = ''; el.textContent = 'Working...'; el.className = 'show';
  fetch(url, { method: 'POST' }).then(function(r) { return r.json(); }).then(function(d) {
    el.textContent = d.message || 'Done';
    el.className = 'show ' + (d.success ? 'success' : 'error');
    if (d.success) {
      htmx.trigger(document.getElementById('summary-section'), 'refreshNow');
      htmx.trigger(document.getElementById('repos-section'), 'refreshNow');
      htmx.trigger(document.getElementById('issues-section'), 'refreshNow');
    }
    setTimeout(function() { el.className = ''; }, 8000);
  }).catch(function(e) { el.textContent = 'Error: ' + e.message; el.className = 'show error'; });
}
</script>
</body>
</html>`;
}

// ── Request handler ──────────────────────────────────────────────────
function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function redirect(res, location) {
  res.writeHead(302, { 'Location': location });
  res.end();
}

export function createDashboardHandler() {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    // Root redirect
    if (req.method === 'GET' && (path === '/' || path === '')) {
      redirect(res, '/dashboard');
      return true;
    }

    if (req.method === 'GET' && path === '/dashboard') {
      sendHtml(res, 200, renderDashboardPage());
      return true;
    }

    if (req.method === 'GET' && path === '/dashboard/partials/summary') {
      try { const data = await fetchOrgData(); sendHtml(res, 200, renderSummaryPartial(data)); }
      catch (err) { getLogger().error({ err }, 'Dashboard summary error'); sendHtml(res, 500, '<div class="badge badge-err">Error loading</div>'); }
      return true;
    }

    if (req.method === 'GET' && path === '/dashboard/partials/repos') {
      try { const data = await fetchOrgData(); sendHtml(res, 200, renderReposPartial(data)); }
      catch (err) { getLogger().error({ err }, 'Dashboard repos error'); sendHtml(res, 500, '<div class="badge badge-err">Error loading</div>'); }
      return true;
    }

    if (req.method === 'GET' && path === '/dashboard/partials/policy') {
      try { const data = await fetchOrgData(); sendHtml(res, 200, renderPolicyPartial(data)); }
      catch (err) { getLogger().error({ err }, 'Dashboard policy error'); sendHtml(res, 500, '<div class="badge badge-err">Error loading</div>'); }
      return true;
    }

    if (req.method === 'GET' && path === '/dashboard/partials/issues') {
      try { const data = await fetchOrgData(); sendHtml(res, 200, renderIssuesPartial(data)); }
      catch (err) { getLogger().error({ err }, 'Dashboard issues error'); sendHtml(res, 500, '<div class="badge badge-err">Error loading</div>'); }
      return true;
    }

    if (req.method === 'GET' && path === '/api/org/health') {
      try { const data = await fetchOrgData(); sendJson(res, 200, { success: true, ...data.summary, timestamp: data.timestamp }); }
      catch (err) { sendJson(res, 500, { success: false, error: err.message }); }
      return true;
    }

    if (req.method === 'GET' && path === '/api/org/repos') {
      try { const data = await fetchOrgData(); sendJson(res, 200, { success: true, repos: data.repos }); }
      catch (err) { sendJson(res, 500, { success: false, error: err.message }); }
      return true;
    }

    if (req.method === 'POST' && path === '/dashboard/actions/refresh') {
      invalidateCache();
      try { await fetchOrgData(); sendJson(res, 200, { success: true, message: 'Cache refreshed' }); }
      catch (err) { sendJson(res, 500, { success: false, message: err.message }); }
      return true;
    }

    if (req.method === 'POST' && path === '/dashboard/actions/sync') {
      try {
        const octokit = await getOctokit();
        const org = getConfig()?.organization || 'pulseengine';
        const result = await synchronizeAllRepositories(octokit, org);
        invalidateCache();
        sendJson(res, 200, { success: result.success, message: result.success ? `Synchronized ${result.repositoriesProcessed} repositories` : result.error });
      } catch (err) { sendJson(res, 500, { success: false, message: err.message }); }
      return true;
    }

    return false;
  };
}
