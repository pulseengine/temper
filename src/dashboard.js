import { getConfig } from './config.js';
import { getLogger } from './logger.js';
import { analyzeOrganizationRepositories, synchronizeAllRepositories } from './organization.js';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

// ── Cache ────────────────────────────────────────────────────────────
const cache = { data: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function isCacheValid() {
  return cache.data && (Date.now() - cache.timestamp) < CACHE_TTL;
}

export function invalidateCache() {
  cache.data = null;
  cache.timestamp = 0;
}

// ── Octokit Factory ──────────────────────────────────────────────────
let _octokit = null;

async function getOctokit() {
  if (_octokit) return _octokit;

  const appId = process.env.APP_ID;
  const privateKey = (process.env.PRIVATE_KEY || '').replace(/\\n/g, '\n');

  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey }
  });

  const { data: installations } = await appOctokit.apps.listInstallations();
  const inst = installations.find(i => i.account?.login === getConfig()?.organization);
  if (!inst) throw new Error('No installation found for org');

  _octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId: inst.id }
  });

  return _octokit;
}

// ── Data Fetching ────────────────────────────────────────────────────
async function fetchOrgData() {
  if (isCacheValid()) return cache.data;

  const octokit = await getOctokit();
  const config = getConfig();
  const org = config?.organization || 'pulseengine';

  const analysis = await analyzeOrganizationRepositories(octokit, org);
  if (!analysis.success) throw new Error(analysis.error);

  const repos = analysis.repositories;

  // Enrich with CI status
  for (const repo of repos) {
    try {
      const { data: runs } = await octokit.actions.listWorkflowRunsForRepo({
        owner: org, repo: repo.name, per_page: 1
      });
      const run = runs.workflow_runs?.[0];
      repo.ci_status = run
        ? { status: run.conclusion || run.status, updated_at: run.updated_at }
        : { status: 'none' };
    } catch {
      repo.ci_status = { status: 'none' };
    }
  }

  const result = {
    org,
    timestamp: new Date().toISOString(),
    repos: repos.sort((a, b) => a.name.localeCompare(b.name)),
    summary: buildSummary(repos)
  };

  cache.data = result;
  cache.timestamp = Date.now();
  return result;
}

function buildSummary(repos) {
  const total = repos.length;
  const withProtection = repos.filter(r => r.configurations?.branch_protection?.exists).length;
  const withCI = repos.filter(r => r.ci_status?.status && r.ci_status.status !== 'none').length;
  const withSigned = repos.filter(r => r.configurations?.branch_protection?.require_signed_commits).length;
  const correctMerge = repos.filter(r => {
    const m = r.configurations?.merge_settings;
    return m && !m.allow_merge_commit && !m.allow_squash_merge && m.allow_rebase_merge && m.delete_branch_on_merge;
  }).length;

  const issues = [];
  repos.forEach(r => {
    if (!r.configurations?.branch_protection?.exists) issues.push(`${r.name}: no branch protection`);
    const m = r.configurations?.merge_settings;
    if (m && (m.allow_merge_commit || m.allow_squash_merge || !m.allow_rebase_merge)) {
      issues.push(`${r.name}: non-standard merge settings`);
    }
  });

  return { total, withProtection, withCI, withSigned, correctMerge, issues };
}

// ── HTML Rendering ───────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function badge(cls, label) { return `<span class="badge ${cls}">${esc(label)}</span>`; }

function ciBadge(status) {
  const map = {
    success: ['badge-ok', 'pass'], failure: ['badge-err', 'fail'],
    cancelled: ['badge-warn', 'cancelled'], in_progress: ['badge-info', 'running'],
    queued: ['badge-info', 'queued'], none: ['badge-muted', 'none']
  };
  const [cls, label] = map[status] || ['badge-muted', status || '?'];
  return badge(cls, label);
}

function mergeLabel(settings) {
  if (!settings || settings.error) return badge('badge-muted', '?');
  if (settings.allow_rebase_merge && !settings.allow_merge_commit && !settings.allow_squash_merge) return badge('badge-ok', 'rebase');
  const parts = [];
  if (settings.allow_rebase_merge) parts.push('rebase');
  if (settings.allow_merge_commit) parts.push('merge');
  if (settings.allow_squash_merge) parts.push('squash');
  return badge('badge-warn', parts.join('+'));
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

function renderSummaryPartial(data) {
  const s = data.summary;
  return `
    <div class="cards">
      <div class="card"><div class="card-value">${s.total}</div><div class="card-label">Total Repos</div></div>
      <div class="card ${s.withProtection === s.total ? 'card-ok' : 'card-warn'}"><div class="card-value">${s.withProtection}</div><div class="card-label">Protected</div></div>
      <div class="card ${s.withCI > 0 ? 'card-ok' : 'card-warn'}"><div class="card-value">${s.withCI}</div><div class="card-label">With CI</div></div>
      <div class="card"><div class="card-value">${s.withSigned}</div><div class="card-label">Signed Commits</div></div>
      <div class="card ${s.correctMerge === s.total ? 'card-ok' : 'card-warn'}"><div class="card-value">${s.correctMerge}</div><div class="card-label">Correct Merge</div></div>
      <div class="card ${s.issues.length === 0 ? 'card-ok' : 'card-err'}"><div class="card-value">${s.issues.length}</div><div class="card-label">Issues</div></div>
    </div>`;
}

function renderReposPartial(data) {
  const rows = data.repos.map(r => {
    const bp = r.configurations?.branch_protection || {};
    const ms = r.configurations?.merge_settings || {};
    return `<tr>
        <td class="repo-name">${esc(r.name)}</td>
        <td>${bp.exists ? badge('badge-ok', 'yes') : badge('badge-warn', 'no')}</td>
        <td>${bp.enforce_admins ? badge('badge-warn', 'enforced') : badge('badge-ok', 'off')}</td>
        <td>${bp.required_reviews > 0 ? badge('badge-warn', bp.required_reviews + ' review') : badge('badge-ok', 'none')}</td>
        <td>${ciBadge(r.ci_status?.status)}</td>
        <td>${mergeLabel(ms)}</td>
        <td class="text-muted">${esc(timeAgo(r.updated_at))}</td>
      </tr>`;
  }).join('');

  return `<table class="repo-table">
      <thead><tr>
        <th>Repository</th><th>Protected</th><th>Enforce Admin</th>
        <th>Reviews</th><th>CI</th><th>Merge</th><th>Updated</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderDashboardPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Temper Dashboard</title>
<script src="https://unpkg.com/htmx.org@2.0.4"></script>
<script src="https://unpkg.com/idiomorph@0.3.0/dist/idiomorph-ext.min.js"></script>
<style>
:root{--bg:#0f1117;--surface:#1a1d27;--surface-raised:#242836;--border:#2e3345;--text:#e1e4ed;--text-muted:#8b90a0;--accent:#6c8cff;--green:#4ade80;--red:#f87171;--amber:#fbbf24;--cyan:#22d3ee}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:ui-monospace,'Cascadia Code','Fira Code',monospace;background:var(--bg);color:var(--text);font-size:14px;line-height:1.5}
.container{max-width:1200px;margin:0 auto;padding:24px}
header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;padding-bottom:16px;border-bottom:1px solid var(--border)}
header h1{font-size:20px;color:var(--accent)}
.header-right{display:flex;align-items:center;gap:12px}
.poll-dot{width:8px;height:8px;border-radius:50%;background:var(--green);box-shadow:0 0 6px var(--green)}
.htmx-indicator{opacity:0;transition:opacity 200ms}
.htmx-request .htmx-indicator,.htmx-request.htmx-indicator{opacity:1}
.pulse{animation:pulse 1.5s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center}
.card-ok{border-color:rgba(74,222,128,.3)}
.card-warn{border-color:rgba(251,191,36,.3)}
.card-err{border-color:rgba(248,113,113,.3)}
.card-value{font-size:28px;font-weight:700;color:var(--text)}
.card-ok .card-value{color:var(--green)}
.card-warn .card-value{color:var(--amber)}
.card-err .card-value{color:var(--red)}
.card-label{font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;margin-top:4px}
.section{margin-bottom:24px}
.section h2{font-size:14px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);margin-bottom:12px}
.repo-table{width:100%;border-collapse:collapse;background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden}
.repo-table th{text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--text-muted);background:var(--surface-raised);border-bottom:1px solid var(--border)}
.repo-table td{padding:8px 14px;border-bottom:1px solid var(--border);transition:background .15s}
.repo-table tr:last-child td{border-bottom:none}
.repo-table tr:hover td{background:var(--surface-raised)}
.repo-name{font-weight:600;color:var(--accent)}
.text-muted{color:var(--text-muted);font-size:12px}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
.badge-ok{background:rgba(74,222,128,.15);color:var(--green)}
.badge-warn{background:rgba(251,191,36,.15);color:var(--amber)}
.badge-err{background:rgba(248,113,113,.15);color:var(--red)}
.badge-info{background:rgba(34,211,238,.15);color:var(--cyan)}
.badge-muted{background:rgba(139,144,160,.15);color:var(--text-muted)}
.actions{display:flex;gap:8px;margin-bottom:16px}
.btn{padding:6px 14px;border:1px solid var(--border);border-radius:6px;background:var(--surface-raised);color:var(--text);font-family:inherit;font-size:12px;cursor:pointer;transition:all .15s}
.btn:hover{border-color:var(--accent);color:var(--accent)}
.btn-primary{border-color:var(--accent);color:var(--accent)}
.btn-primary:hover{background:var(--accent);color:var(--bg)}
#action-result{margin-bottom:12px;padding:8px 12px;border-radius:6px;font-size:12px;display:none}
#action-result.show{display:block}
#action-result.success{background:rgba(74,222,128,.1);border:1px solid rgba(74,222,128,.3);color:var(--green)}
#action-result.error{background:rgba(248,113,113,.1);border:1px solid rgba(248,113,113,.3);color:var(--red)}
.cache-info{font-size:11px;color:var(--text-muted)}
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
</style>
</head>
<body hx-ext="morph">
<div class="container">
  <header>
    <h1>temper</h1>
    <div class="header-right">
      <span class="poll-dot htmx-indicator" id="poll-indicator"></span>
      <span class="text-muted">governance dashboard</span>
    </div>
  </header>
  <div id="summary-section"
       hx-get="/dashboard/partials/summary"
       hx-trigger="load, every 60s"
       hx-swap="morph:innerHTML"
       hx-indicator="#poll-indicator"></div>
  <div class="section">
    <h2>Actions</h2>
    <div class="actions">
      <button class="btn btn-primary" onclick="dashAction('/dashboard/actions/sync')">Sync All Repos</button>
      <button class="btn" onclick="dashAction('/dashboard/actions/refresh')">Refresh Cache</button>
    </div>
    <div id="action-result"></div>
  </div>
  <div class="section">
    <h2>Repositories</h2>
    <div id="repos-section"
         hx-get="/dashboard/partials/repos"
         hx-trigger="load, every 60s"
         hx-swap="morph:innerHTML"
         hx-indicator="#poll-indicator"></div>
  </div>
</div>
<script>
function dashAction(url){
  var el=document.getElementById('action-result');
  el.className='';el.textContent='Working...';el.className='show';
  fetch(url,{method:'POST'}).then(function(r){return r.json()}).then(function(d){
    el.textContent=d.message||'Done';
    el.className='show '+(d.success?'success':'error');
    if(d.success){htmx.trigger(document.getElementById('summary-section'),'refreshNow');htmx.trigger(document.getElementById('repos-section'),'refreshNow')}
    setTimeout(function(){el.className=''},8000);
  }).catch(function(e){el.textContent='Error: '+e.message;el.className='show error'});
}
</script>
</body>
</html>`;
}

// ── Handler for Probot's addHandler pattern ──────────────────────────
// Returns async (req, res) => boolean, matching Probot v14's handler chain

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export function createDashboardHandler() {
  return async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    // GET /dashboard — main page
    if (req.method === 'GET' && path === '/dashboard') {
      sendHtml(res, 200, renderDashboardPage());
      return true;
    }

    // GET /dashboard/partials/summary
    if (req.method === 'GET' && path === '/dashboard/partials/summary') {
      try {
        const data = await fetchOrgData();
        sendHtml(res, 200, renderSummaryPartial(data));
      } catch (err) {
        getLogger().error({ err }, 'Dashboard summary error');
        sendHtml(res, 500, '<div class="badge badge-err">Error loading summary</div>');
      }
      return true;
    }

    // GET /dashboard/partials/repos
    if (req.method === 'GET' && path === '/dashboard/partials/repos') {
      try {
        const data = await fetchOrgData();
        sendHtml(res, 200, renderReposPartial(data));
      } catch (err) {
        getLogger().error({ err }, 'Dashboard repos error');
        sendHtml(res, 500, '<div class="badge badge-err">Error loading repos</div>');
      }
      return true;
    }

    // GET /api/org/health — JSON summary
    if (req.method === 'GET' && path === '/api/org/health') {
      try {
        const data = await fetchOrgData();
        sendJson(res, 200, { success: true, ...data.summary, timestamp: data.timestamp });
      } catch (err) {
        sendJson(res, 500, { success: false, error: err.message });
      }
      return true;
    }

    // GET /api/org/repos — JSON repo list
    if (req.method === 'GET' && path === '/api/org/repos') {
      try {
        const data = await fetchOrgData();
        sendJson(res, 200, { success: true, repos: data.repos });
      } catch (err) {
        sendJson(res, 500, { success: false, error: err.message });
      }
      return true;
    }

    // POST /dashboard/actions/refresh
    if (req.method === 'POST' && path === '/dashboard/actions/refresh') {
      invalidateCache();
      try {
        await fetchOrgData();
        sendJson(res, 200, { success: true, message: 'Cache refreshed' });
      } catch (err) {
        sendJson(res, 500, { success: false, message: err.message });
      }
      return true;
    }

    // POST /dashboard/actions/sync
    if (req.method === 'POST' && path === '/dashboard/actions/sync') {
      try {
        const octokit = await getOctokit();
        const org = getConfig()?.organization || 'pulseengine';
        const result = await synchronizeAllRepositories(octokit, org);
        invalidateCache();
        sendJson(res, 200, {
          success: result.success,
          message: result.success
            ? `Synchronized ${result.repositoriesProcessed} repositories`
            : result.error
        });
      } catch (err) {
        sendJson(res, 500, { success: false, message: err.message });
      }
      return true;
    }

    return false;
  };
}
