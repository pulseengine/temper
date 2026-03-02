import { getConfig } from './config.js';
import { getLogger } from './logger.js';
import { analyzeOrganizationRepositories, synchronizeAllRepositories, generateOrganizationAnalysisReport } from './organization.js';
import { checkDependabotConfiguration, checkExistingDependabotConfig, fixDependabotPRLabels } from './dependabot.js';
import { generateConfigurationReport } from './reporting.js';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { getReviews, getReviewStats, reviewPullRequest } from './ai-review.js';

// ── Cache ────────────────────────────────────────────────────────────
const cache = { data: null, timestamp: 0 };
const CACHE_TTL = 60 * 60 * 1000; // 60 min — webhooks invalidate on actual changes
const STALE_TTL = 4 * 60 * 60 * 1000; // 4 hours — serve stale data if rate-limited
function isCacheValid() { return cache.data && (Date.now() - cache.timestamp) < CACHE_TTL; }
function isCacheStale() { return cache.data && (Date.now() - cache.timestamp) < STALE_TTL; }

// ── Rate limit tracking ─────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
let rateLimitInfo = { remaining: null, limit: null, resetAt: null };

// Called by webhooks on push/PR/protection events to keep dashboard fresh
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

  // Check rate limit before making expensive calls
  try {
    const rl = await octokit.rateLimit.get();
    const core = rl.data.rate;
    rateLimitInfo = { remaining: core.remaining, limit: core.limit, resetAt: new Date(core.reset * 1000) };
    if (core.remaining < 50) {
      // If we have stale cache, serve it instead of erroring
      if (isCacheStale()) {
        getLogger().info({ remaining: core.remaining, cacheAge: Math.round((Date.now() - cache.timestamp) / 60000) + 'min' }, 'Rate limited, serving stale cache');
        return cache.data;
      }
      const resetIn = Math.ceil((core.reset * 1000 - Date.now()) / 60000);
      const err = new Error(`GitHub API rate limit: ${core.remaining}/${core.limit} remaining. Resets in ${resetIn} minutes.`);
      err.isRateLimit = true;
      err.resetMinutes = resetIn;
      throw err;
    }
  } catch (err) {
    if (err.isRateLimit) throw err;
    // If rate limit check itself fails, continue and hope for the best
  }

  const config = getConfig();
  const org = config?.organization || 'pulseengine';
  const analysis = await analyzeOrganizationRepositories(octokit, org);
  if (!analysis.success) throw new Error(analysis.error);
  const repos = analysis.repositories;

  const enrichPromises = repos.map(async (repo) => {
    try {
      const { data: runs } = await octokit.actions.listWorkflowRunsForRepo({ owner: org, repo: repo.name, per_page: 1 });
      const run = runs.workflow_runs?.[0];
      repo.ci_status = run ? { status: run.conclusion || run.status, updated_at: run.updated_at, url: run.html_url } : { status: 'none' };
    } catch { repo.ci_status = { status: 'none' }; }
    try {
      const { data: rd } = await octokit.repos.get({ owner: org, repo: repo.name });
      repo.auto_merge_enabled = rd.allow_auto_merge || false;
    } catch { repo.auto_merge_enabled = false; }
    try {
      await octokit.repos.getCommitSignatureProtection({ owner: org, repo: repo.name, branch: repo.configurations?.default_branch || 'main' });
      repo.signed_commits_required = true;
    } catch { repo.signed_commits_required = false; }
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
      issues.push({ repo: r.name, type: 'labels', msg: 'Missing ' + (targetLabels - (r.configurations?.labels?.standard_labels?.length || 0)) + ' labels' });
  });
  return { total, withProtection, withCI, ciPassing, withSigned, withAutoMerge, correctMerge, withAllLabels, targetLabels, totalPRs, issues };
}

// ── Rendering helpers ────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function badge(variant, label) {
  const cls = { ok:'badge-ok', warn:'badge-warn', err:'badge-err', info:'badge-info', muted:'badge-muted' };
  return '<span class="badge ' + (cls[variant]||'badge-muted') + '">' + esc(label) + '</span>';
}

function ciBadge(status) {
  const map = { success:'ok', pass:'ok', failure:'err', fail:'err', cancelled:'warn',
    in_progress:'info', running:'info', queued:'info', pending:'warn', none:'muted', unknown:'muted' };
  const labels = { success:'pass', failure:'fail', in_progress:'running', queued:'queued', none:'none', unknown:'?',
    pass:'pass', fail:'fail', running:'running', pending:'pending' };
  return badge(map[status]||'muted', labels[status]||status||'?');
}

function mergeLabel(s) {
  if (!s || s.error) return badge('muted','?');
  const p = [];
  if (s.allow_merge_commit) p.push('merge');
  if (s.allow_squash_merge) p.push('squash');
  if (s.allow_rebase_merge) p.push('rebase');
  return badge(p.length <= 2 ? 'ok' : 'warn', p.join('+') || 'none');
}

function timeAgo(d) {
  if (!d) return '';
  const diff = Date.now() - new Date(d).getTime();
  const m = Math.floor(diff/60000);
  if (m < 60) return m + 'm';
  const h = Math.floor(m/60);
  if (h < 24) return h + 'h';
  return Math.floor(h/24) + 'd';
}

function ageClass(d) {
  if (!d) return '';
  const days = (Date.now() - new Date(d).getTime()) / 86400000;
  if (days < 1) return 'age-fresh';
  if (days < 7) return 'age-stale';
  return 'age-old';
}

// ── Partials ─────────────────────────────────────────────────────────
function renderSummaryPartial(data) {
  const s = data.summary;
  const t = s.total;
  const score = t === 0 ? 0 : Math.round(((s.withProtection + s.correctMerge + s.withSigned + s.withAutoMerge + s.withAllLabels) / (t * 5)) * 100);
  const scoreThreshold = score >= 90 ? 'ok' : score >= 70 ? 'warn' : 'err';

  function stat(value, total, label, metric, icon) {
    const pct = total > 0 ? Math.round((parseInt(value) / total) * 100) : 0;
    const threshold = total > 0 && parseInt(value) < total ? 'warn' : 'ok';
    return '<div class="stat-card" data-threshold="' + threshold + '">' +
      '<div class="stat-label">' + icon + ' ' + esc(label) + '</div>' +
      '<div class="stat-value" data-metric="' + metric + '">' + esc(String(value)) + '</div>' +
      (total > 0 ? '<div class="stat-sub">' + pct + '% of ' + total + '</div>' : '') +
    '</div>';
  }

  return '<div class="signals-grid">' +
    '<div class="score-card" data-threshold="' + scoreThreshold + '">' +
      '<div class="score-label">COMPLIANCE</div>' +
      '<div class="score-value">' + score + '<span class="score-pct">%</span></div>' +
      '<div class="score-bar"><div class="score-bar-fill" style="width:' + score + '%"></div></div>' +
      '<div class="score-sub">' + t + ' repositories monitored</div>' +
    '</div>' +
    '<div class="stat-grid">' +
      stat(s.withProtection, t, 'Protected', 'protected', '&#9632;') +
      stat(s.withSigned, t, 'Signed', 'signed', '&#9670;') +
      stat(s.ciPassing, s.withCI, 'CI Passing', 'ci', '&#9654;') +
      stat(s.correctMerge, t, 'Merge OK', 'merge', '&#9644;') +
      stat(s.withAutoMerge, t, 'Auto-Merge', 'auto', '&#8635;') +
      stat(s.withAllLabels, t, 'Labels', 'labels', '&#9733;') +
      stat(s.totalPRs, 0, 'Open PRs', 'prs', '&#8689;') +
      stat(s.issues.length, 0, 'Issues', 'issues', '&#9888;') +
    '</div>' +
  '</div>';
}

function renderPolicyPartial(data) {
  const config = data.config || {};
  const merge = config?.settings?.merge || {};
  const bp = config?.branch_protection?.default || {};
  const am = config?.auto_merge || {};
  const checks = bp?.required_status_checks?.contexts || [];
  const labels = (config?.issue_labels || []).map(l => l.name);

  function row(label, value, note) {
    return '<tr><td class="row-label">' + esc(label) + '</td><td>' + value + '</td>' +
      (note ? '<td class="row-note">' + esc(note) + '</td>' : '<td></td>') + '</tr>';
  }
  function okBadge(ok, y, n) { return ok ? badge('ok', y||'yes') : badge('warn', n||'no'); }

  return '<div class="policy-grid">' +
    '<div class="policy-card"><div class="policy-card-header">Merge Strategy</div><table>' +
      row('Merge commit', okBadge(merge.allow_merge_commit,'allowed','blocked'), 'Preserves signatures') +
      row('Squash merge', okBadge(merge.allow_squash_merge,'allowed','blocked'), 'GitHub signs squash') +
      row('Rebase merge', merge.allow_rebase_merge ? badge('warn','allowed') : badge('ok','blocked'), 'Cannot be signed') +
      row('Delete branch', okBadge(merge.delete_branch_on_merge)) +
      row('Auto-merge', okBadge(merge.allow_auto_merge)) +
    '</table></div>' +
    '<div class="policy-card"><div class="policy-card-header">Branch Protection</div><table>' +
      row('Enforce admins', bp.enforce_admins ? badge('warn','yes') : badge('ok','no'), bp.enforce_admins ? 'Admins subject to rules' : 'Admin can bypass') +
      row('PR reviews', bp.required_pull_request_reviews === null ? badge('ok','none') : badge('warn', JSON.stringify(bp.required_pull_request_reviews))) +
      row('Signed commits', okBadge(bp.require_signed_commits, 'required', 'not required')) +
      row('Linear history', okBadge(bp.required_linear_history, 'required', 'not required')) +
      row('Force pushes', bp.allow_force_pushes ? badge('err','allowed') : badge('ok','blocked')) +
      row('Deletions', bp.allow_deletions ? badge('err','allowed') : badge('ok','blocked')) +
      row('Status checks', checks.length > 0 ? badge('info', checks.join(', ')) : badge('muted','none')) +
    '</table></div>' +
    '<div class="policy-card"><div class="policy-card-header">Auto-Merge Rules</div><table>' +
      row('Enabled', okBadge(am.enabled)) +
      row('Dependabot PRs', okBadge(am.on_dependabot)) +
      row('Bot users', (am.on_bot_users||[]).length > 0 ? badge('info',(am.on_bot_users||[]).join(', ')) : badge('muted','none')) +
      row('Method', badge('info', am.merge_method || 'squash')) +
    '</table></div>' +
    '<div class="policy-card"><div class="policy-card-header">Standard Labels (' + labels.length + ')</div>' +
      '<div class="label-grid">' + labels.map(l => '<span class="badge badge-muted">' + esc(l) + '</span>').join('') + '</div>' +
    '</div>' +
  '</div>';
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
    const okB = (ok) => ok ? badge('ok','yes') : badge('warn','no');

    return '<tr>' +
      '<td><a href="https://github.com/' + esc(data.org) + '/' + esc(r.name) + '" target="_blank">' + esc(r.name) + '</a>' +
        (prCount > 0 ? ' <span class="badge badge-info">' + prCount + '</span>' : '') + '</td>' +
      '<td>' + okB(bp.exists) + '</td>' +
      '<td>' + okB(r.signed_commits_required) + '</td>' +
      '<td>' + ciBadge(r.ci_status?.status) + '</td>' +
      '<td>' + mergeLabel(ms) + '</td>' +
      '<td>' + okB(r.auto_merge_enabled) + '</td>' +
      '<td>' + okB(dep.exists) + '</td>' +
      '<td>' + badge(hasAllLabels?'ok':'warn', (lbls.standard_labels?.length||0)+'/'+targetLabels) + '</td>' +
      '<td class="dim">' + esc(timeAgo(r.updated_at)) + '</td>' +
    '</tr>';
  }).join('');

  return '<div class="table-wrap"><table id="repos-table">' +
    '<thead><tr>' +
      '<th data-sort="">Repository</th><th data-sort="">Protected</th><th data-sort="">Signed</th><th data-sort="">CI</th>' +
      '<th data-sort="">Merge</th><th data-sort="">Auto</th><th data-sort="">Dependabot</th><th data-sort="">Labels</th><th data-sort="">Updated</th>' +
    '</tr></thead>' +
    '<tbody>' + rows + '</tbody>' +
  '</table></div>';
}

function renderPRsPartial(data) {
  if (data.prs.length === 0) {
    return '<div class="alert alert-ok">No open pull requests.</div>';
  }
  const byRepo = {};
  data.prs.forEach(pr => { if (!byRepo[pr.repo]) byRepo[pr.repo] = []; byRepo[pr.repo].push(pr); });

  const groups = Object.entries(byRepo).sort((a, b) => {
    const oa = Math.min(...a[1].map(p => new Date(p.created_at).getTime()));
    const ob = Math.min(...b[1].map(p => new Date(p.created_at).getTime()));
    return oa - ob;
  }).map(([repo, prs]) => {
    prs.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const failing = prs.filter(p => p.checkStatus === 'fail' || p.checkStatus === 'failure').length;
    const rows = prs.map(pr =>
      '<tr>' +
        '<td><a href="' + esc(pr.url) + '" target="_blank">#' + pr.number + '</a> ' + esc(pr.title) +
          (pr.draft ? ' <span class="badge badge-muted">draft</span>' : '') + '</td>' +
        '<td>' + ciBadge(pr.checkStatus) + '</td>' +
        '<td class="dim">' + esc(pr.user) + '</td>' +
        '<td>' + (pr.labels||[]).map(l => '<span class="badge badge-muted">' + esc(l) + '</span>').join(' ') + '</td>' +
        '<td class="' + ageClass(pr.created_at) + '">' + esc(timeAgo(pr.created_at)) + '</td>' +
      '</tr>'
    ).join('');

    const isOpen = prs.length <= 3 || failing > 0;
    return '<div class="pr-group' + (isOpen ? ' open' : '') + '">' +
      '<div class="pr-group-header">' +
        '<span class="pr-group-toggle">&#9654;</span>' +
        '<a href="https://github.com/' + esc(data.org) + '/' + esc(repo) + '" target="_blank">' + esc(repo) + '</a>' +
        ' <span class="badge badge-muted">' + prs.length + '</span>' +
        (failing > 0 ? ' ' + badge('err', failing + ' failing') : '') +
      '</div>' +
      '<div class="pr-group-body"><table>' +
        '<thead><tr><th>PR</th><th>Checks</th><th>Author</th><th>Labels</th><th>Age</th></tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table></div>' +
    '</div>';
  }).join('');

  return '<div class="pr-summary">' + data.prs.length + ' open across ' + Object.keys(byRepo).length + ' repos</div>' + groups;
}

function renderIssuesPartial(data) {
  const issues = data.summary.issues;
  if (issues.length === 0) {
    return '<div class="alert alert-ok">All repositories compliant. No drift detected.</div>';
  }
  const byRepo = {};
  issues.forEach(i => { if (!byRepo[i.repo]) byRepo[i.repo] = []; byRepo[i.repo].push(i); });
  const rows = Object.entries(byRepo).map(([repo, items]) => {
    const badges = items.map(i => badge(i.type === 'protection' ? 'err' : 'warn', i.msg)).join(' ');
    return '<tr><td class="row-label">' + esc(repo) + '</td><td>' + badges + '</td></tr>';
  }).join('');

  return '<div class="alert alert-err">' + issues.length + ' issues across ' + Object.keys(byRepo).length + ' repos</div>' +
    '<div class="table-wrap"><table><thead><tr><th>Repository</th><th>Issues</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}

// ── AI Reviews partial ───────────────────────────────────────────────
function renderReviewsPartial() {
  let reviews;
  try { reviews = getReviews({ limit: 15 }); } catch { reviews = []; }
  if (reviews.length === 0) {
    return '<div class="alert" style="color:var(--dim);background:var(--surface);border:1px solid var(--border)">No AI reviews yet. Reviews are triggered automatically on PR open/sync, or manually via <span style="color:var(--accent)">/review-pr</span> command.</div>';
  }

  const assessmentBadge = (a) => {
    if (a === 'approve') return badge('ok', 'approve');
    if (a === 'minor') return badge('warn', 'minor changes');
    if (a === 'major') return badge('err', 'major changes');
    return badge('muted', 'review');
  };

  const rows = reviews.map(r => {
    const findingsTag = r.findings > 0
      ? ' ' + badge(r.findings > 2 ? 'err' : 'warn', r.findings + ' finding' + (r.findings !== 1 ? 's' : ''))
      : '';
    return '<div class="review-card">' +
      '<div class="review-header">' +
        '<a href="' + esc(r.url || '#') + '" target="_blank">' + esc(r.repo) + ' #' + r.pr + '</a> ' +
        assessmentBadge(r.assessment) + findingsTag +
        '<span class="dim" style="margin-left:auto">' + esc(timeAgo(r.timestamp)) + ' ago</span>' +
      '</div>' +
      '<div class="review-title">' + esc(r.title || '') + '</div>' +
      '<div class="review-summary">' + esc(r.summary || '') + '</div>' +
      '<div class="review-meta">' + esc(r.model || '') + ' &middot; ' + esc(r.author || '') + '</div>' +
    '</div>';
  }).join('');

  return rows;
}

// ── Full reviews partial (for dedicated Reviews tab) ─────────────────

function reviewAssessmentBadge(a) {
  if (a === 'approve') return badge('ok', 'approve');
  if (a === 'minor') return badge('warn', 'minor');
  if (a === 'major') return badge('err', 'major');
  return badge('muted', 'no verdict');
}

function reviewVerdictIcon(a) {
  if (a === 'approve') return '<span class="verdict-icon verdict-approve">&#10003;</span>';
  if (a === 'minor') return '<span class="verdict-icon verdict-minor">&#9888;</span>';
  if (a === 'major') return '<span class="verdict-icon verdict-major">&#10007;</span>';
  return '<span class="verdict-icon verdict-unknown">?</span>';
}

function renderReviewStatsBanner(stats) {
  const cards = [
    { label: 'Total', value: stats.total, cls: '' },
    { label: 'Approved', value: stats.approve, cls: 'stat-green' },
    { label: 'Minor', value: stats.minor, cls: 'stat-yellow' },
    { label: 'Major', value: stats.major, cls: 'stat-red' },
    { label: 'This Week', value: stats.thisWeek, cls: '' },
    { label: 'Avg Findings', value: stats.avgFindings, cls: '' },
  ];
  const inner = cards.map(c =>
    '<div class="stat-card' + (c.cls ? ' ' + c.cls : '') + '">' +
      '<div class="stat-value">' + c.value + '</div>' +
      '<div class="stat-label">' + c.label + '</div>' +
    '</div>'
  ).join('');
  return '<div class="reviews-stats-banner">' + inner + '</div>';
}

function renderReviewRowPair(r) {
  const id = esc(r.id || (r.repo + '-' + r.pr + '-' + r.timestamp));
  const findingsTag = r.findings > 0
    ? ' ' + badge(r.findings > 2 ? 'err' : 'warn', r.findings + ' finding' + (r.findings !== 1 ? 's' : ''))
    : '';
  const repoShort = (r.repo || '').split('/').pop();

  const dataRow =
    '<tr class="review-row" data-review-id="' + id + '">' +
      '<td>' + reviewVerdictIcon(r.assessment) + '</td>' +
      '<td>' + esc(repoShort) + '</td>' +
      '<td><a href="' + esc(r.url || '#') + '" target="_blank">#' + r.pr + '</a></td>' +
      '<td class="review-row-title">' + esc(r.title || '') + '</td>' +
      '<td>' + reviewAssessmentBadge(r.assessment) + findingsTag + '</td>' +
      '<td>' + (r.findings || 0) + '</td>' +
      '<td>' + esc(r.author || '') + '</td>' +
      '<td class="dim">' + esc(timeAgo(r.timestamp)) + '</td>' +
    '</tr>';

  const detailRow =
    '<tr class="review-detail-row" data-pair-of="' + id + '" style="display:none">' +
      '<td colspan="8">' +
        '<div class="review-detail-inner">' +
          '<div class="review-detail-summary"><strong>Summary:</strong> ' + esc(r.summary || 'No summary available') + '</div>' +
          '<div class="review-detail-body">' + (r.body || '<em>No review body stored</em>') + '</div>' +
          '<div class="review-detail-actions">' +
            '<div class="review-retrigger">' +
              '<input class="filter-input" id="review-instructions-' + esc(r.repo) + '-' + r.pr +
                '" placeholder="extra instructions (e.g. focus on security)" style="flex:1" />' +
              '<button class="cmd-btn" onclick="triggerReview(\'' + esc(r.repo) + '\',' + r.pr + ')">RE-REVIEW</button>' +
            '</div>' +
            '<div class="review-action-status" id="review-status-' + esc(r.repo) + '-' + r.pr + '"></div>' +
          '</div>' +
        '</div>' +
      '</td>' +
    '</tr>';

  return dataRow + detailRow;
}

function renderReviewsTable(reviews) {
  const headers =
    '<thead><tr>' +
      '<th data-sort="">V</th>' +
      '<th data-sort="">Repo</th>' +
      '<th data-sort="">PR</th>' +
      '<th data-sort="">Title</th>' +
      '<th data-sort="">Assessment</th>' +
      '<th data-sort="">Findings</th>' +
      '<th data-sort="">Author</th>' +
      '<th data-sort="">Age</th>' +
    '</tr></thead>';

  const rows = reviews.map(renderReviewRowPair).join('');

  return '<div class="table-wrap"><table id="reviews-table">' + headers + '<tbody>' + rows + '</tbody></table></div>';
}

function renderReviewsFullPartial(url) {
  const params = new URL(url || 'http://x/', 'http://x').searchParams;
  const limit = parseInt(params.get('limit')) || 25;
  const offset = parseInt(params.get('offset')) || 0;

  let stats;
  try { stats = getReviewStats(); } catch { stats = { total: 0, approve: 0, minor: 0, major: 0, unknown: 0, thisWeek: 0, avgFindings: 0 }; }

  const badgeScript = '<span data-metric="reviews" style="display:none">' + stats.total + '</span>';

  if (stats.total === 0) {
    return badgeScript +
      '<div class="empty-state">' +
        '<div class="empty-icon">&#9776;</div>' +
        '<div class="empty-title">No reviews yet</div>' +
        '<div class="empty-text">AI reviews are triggered automatically when PRs are opened or updated, ' +
        'or manually with <code>/review-pr</code> on any PR comment.</div>' +
      '</div>';
  }

  let reviews;
  try { reviews = getReviews({ limit, offset }); } catch { reviews = []; }

  const hasMore = (offset + limit) < stats.total;
  const nextOffset = offset + limit;
  const loadMoreBtn = hasMore
    ? '<div class="reviews-load-more">' +
        '<button class="cmd-btn-ghost" id="reviews-load-more-btn" ' +
          'hx-get="/dashboard/partials/reviews-more?limit=' + limit + '&offset=' + nextOffset + '" ' +
          'hx-target="#reviews-table tbody" hx-swap="beforeend" hx-indicator="#poll-indicator">' +
          'Load more (' + (stats.total - nextOffset) + ' remaining)</button>' +
      '</div>'
    : '';

  return badgeScript + renderReviewStatsBanner(stats) + renderReviewsTable(reviews) + loadMoreBtn;
}

function renderReviewsMorePartial(url) {
  const params = new URL(url || 'http://x/', 'http://x').searchParams;
  const limit = parseInt(params.get('limit')) || 25;
  const offset = parseInt(params.get('offset')) || 0;

  let reviews, stats;
  try { reviews = getReviews({ limit, offset }); } catch { reviews = []; }
  try { stats = getReviewStats(); } catch { stats = { total: 0 }; }

  const rows = reviews.map(renderReviewRowPair).join('');

  const hasMore = (offset + limit) < stats.total;
  const nextOffset = offset + limit;
  // OOB swap to update the load-more button
  const oobBtn = hasMore
    ? '<div id="reviews-load-more-btn" hx-swap-oob="outerHTML" class="reviews-load-more">' +
        '<button class="cmd-btn-ghost" id="reviews-load-more-btn" ' +
          'hx-get="/dashboard/partials/reviews-more?limit=' + limit + '&offset=' + nextOffset + '" ' +
          'hx-target="#reviews-table tbody" hx-swap="beforeend" hx-indicator="#poll-indicator">' +
          'Load more (' + (stats.total - nextOffset) + ' remaining)</button>' +
      '</div>'
    : '<div id="reviews-load-more-btn" hx-swap-oob="outerHTML"></div>';

  return rows + oobBtn;
}

// ── Static assets ────────────────────────────────────────────────────
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
const dashModuleFile = fileURLToPath(import.meta.url);
const dashModuleDir = dirname(dashModuleFile);
const CLIENT_JS = readFileSync(join(dashModuleDir, 'dashboard-client.js'), 'utf8');
const HTMX_JS = readFileSync(join(dashModuleDir, 'htmx.min.js'), 'utf8');
const IDIOMORPH_JS = readFileSync(join(dashModuleDir, 'idiomorph-ext.min.js'), 'utf8');

// ── CSS ──────────────────────────────────────────────────────────────
const CSS = `
*{margin:0;padding:0;box-sizing:border-box}
:root{
  --bg:#0a0a0f;--surface:#111118;--surface2:#1a1a25;
  --border:#1e1e2a;--border-accent:rgba(200,255,0,0.2);
  --text:#c8ccd0;--dim:#555;
  --accent:#c8ff00;--accent-dim:#7a9900;
  --err:#ff3333;--warn:#ffaa00;--ok:#00ff66;--info:#6c8cff;
}
html{font-size:14px}
body{background:var(--bg);color:var(--text);font-family:'SF Mono','Fira Code','Cascadia Code','JetBrains Mono',monospace;min-height:100vh}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}

/* ── Topnav ── */
.topnav{background:var(--surface);border-bottom:1px solid var(--border);display:flex;align-items:center;padding:0 1.5rem;height:48px;position:sticky;top:0;z-index:100}
.logo{font-size:1.1rem;font-weight:900;letter-spacing:0.2em;text-transform:uppercase;color:var(--accent);font-style:italic;text-shadow:0 0 12px rgba(200,255,0,0.3);cursor:default;user-select:none}
.nav-tabs{display:flex;gap:0;margin-left:2rem;height:100%}
.nav-tab{display:flex;align-items:center;padding:0 1rem;cursor:pointer;color:var(--dim);font-size:0.7rem;text-transform:uppercase;letter-spacing:0.12em;border-bottom:2px solid transparent;transition:color .15s,border-color .15s}
.nav-tab:hover{color:var(--text)}
.nav-tab.tab-active{color:var(--accent);border-bottom-color:var(--accent)}
.nav-tab .tab-badge{font-size:0.6rem;background:var(--surface2);color:var(--dim);padding:0.1rem 0.35rem;border-radius:2px;margin-left:0.4rem}
.nav-right{margin-left:auto;display:flex;align-items:center;gap:0.75rem}
.nav-status{font-size:0.6rem;color:var(--dim);letter-spacing:0.05em}

/* ── Buttons ── */
.cmd-btn{background:var(--accent);color:var(--bg);border:none;padding:0.35rem 0.75rem;font-size:0.65rem;font-weight:700;cursor:pointer;border-radius:2px;text-transform:uppercase;letter-spacing:0.05em;font-family:inherit}
.cmd-btn:hover{opacity:0.85}
.cmd-btn-ghost{background:transparent;color:var(--accent);border:1px solid var(--border);padding:0.35rem 0.75rem;font-size:0.65rem;font-weight:600;cursor:pointer;border-radius:2px;text-transform:uppercase;letter-spacing:0.05em;font-family:inherit}
.cmd-btn-ghost:hover{border-color:var(--accent)}

/* ── Panels ── */
.main-content{padding:1.5rem 2rem}
.panel{display:none}.panel.active{display:block}

/* ── Stat cards ── */
.signals-grid{display:flex;flex-direction:column;gap:1.5rem}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:0.75rem}
.stat-card{background:var(--surface);border:1px solid var(--border);padding:0.75rem 1rem;border-radius:2px;transition:box-shadow .2s,border-color .2s}
.stat-card:hover{border-color:var(--border-accent);box-shadow:0 0 15px rgba(200,255,0,0.06)}
.stat-label{font-size:0.6rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--dim)}
.stat-value{font-size:1.4rem;font-weight:700;color:var(--accent);margin:0.2rem 0}
.stat-sub{font-size:0.6rem;color:var(--dim)}

/* Score card */
.score-card{background:var(--surface);border:1px solid var(--accent);box-shadow:0 0 25px rgba(200,255,0,0.08);padding:1.25rem 1.5rem;border-radius:2px;display:flex;align-items:center;gap:2rem}
.score-label{font-size:0.65rem;text-transform:uppercase;letter-spacing:0.15em;color:var(--dim);margin-bottom:0.25rem}
.score-value{font-size:3rem;font-weight:900;color:var(--accent);line-height:1}
.score-pct{font-size:1.2rem;color:var(--dim)}
.score-bar{flex:1;height:4px;background:var(--surface2);border-radius:2px;overflow:hidden}
.score-bar-fill{height:100%;background:var(--accent);transition:width .5s}
.score-sub{font-size:0.65rem;color:var(--dim);white-space:nowrap}

/* ── Tables ── */
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:0.75rem}
th{text-align:left;padding:0.5rem 0.6rem;font-size:0.6rem;text-transform:uppercase;letter-spacing:0.1em;color:var(--dim);border-bottom:1px solid var(--border);cursor:pointer;white-space:nowrap;user-select:none}
td{padding:0.5rem 0.6rem;border-bottom:1px solid var(--border)}
tr:hover td{background:var(--surface2)}
th[data-sort="asc"]::after{content:" \\25B2";color:var(--accent)}
th[data-sort="desc"]::after{content:" \\25BC";color:var(--accent)}
.dim{color:var(--dim);font-size:0.7rem}
.row-label{font-weight:600}
.row-note{font-size:0.65rem;color:var(--dim)}

/* ── Badges ── */
.badge{display:inline-block;padding:0.1rem 0.4rem;font-size:0.6rem;font-weight:600;border-radius:2px;text-transform:uppercase;letter-spacing:0.04em;white-space:nowrap}
.badge-ok{background:rgba(0,255,102,0.12);color:var(--ok)}
.badge-warn{background:rgba(255,170,0,0.12);color:var(--warn)}
.badge-err{background:rgba(255,51,51,0.12);color:var(--err)}
.badge-info{background:rgba(108,140,255,0.12);color:var(--info)}
.badge-muted{background:rgba(255,255,255,0.04);color:var(--dim)}

/* ── Alerts ── */
.alert{padding:0.6rem 1rem;border-radius:2px;font-size:0.75rem;margin-bottom:0.75rem}
.alert-ok{background:rgba(0,255,102,0.08);color:var(--ok);border:1px solid rgba(0,255,102,0.15)}
.alert-err{background:rgba(255,51,51,0.08);color:var(--err);border:1px solid rgba(255,51,51,0.15)}

/* ── PR groups ── */
.pr-summary{font-size:0.7rem;color:var(--dim);margin-bottom:0.75rem}
.pr-group{background:var(--surface);border:1px solid var(--border);margin-bottom:0.5rem;border-radius:2px;overflow:hidden}
.pr-group-header{padding:0.6rem 0.75rem;cursor:pointer;display:flex;align-items:center;gap:0.5rem;font-size:0.8rem}
.pr-group-header:hover{background:var(--surface2)}
.pr-group-body{display:none;border-top:1px solid var(--border)}
.pr-group.open .pr-group-body{display:block}
.pr-group-toggle{color:var(--dim);font-size:0.6rem;transition:transform .15s;display:inline-block}
.pr-group.open .pr-group-toggle{transform:rotate(90deg)}
.age-fresh{color:var(--ok)}.age-stale{color:var(--warn)}.age-old{color:var(--err)}

/* ── Policy ── */
.policy-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:0.75rem}
.policy-card{background:var(--surface);border:1px solid var(--border);border-radius:2px;overflow:hidden}
.policy-card-header{padding:0.5rem 0.75rem;font-size:0.6rem;text-transform:uppercase;letter-spacing:0.12em;color:var(--accent);font-weight:700;background:var(--surface2);border-bottom:1px solid var(--border)}
.policy-card table{margin:0}
.label-grid{display:flex;flex-wrap:wrap;gap:0.35rem;padding:0.75rem}

/* ── Command cards ── */
.cmd-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:0.75rem}
.cmd-card{background:var(--surface);border:1px solid var(--border);padding:1rem;border-radius:2px;transition:border-color .15s}
.cmd-card:hover{border-color:var(--border-accent)}
.cmd-card h3{font-size:0.8rem;font-weight:600;margin-bottom:0.25rem}
.cmd-card p{font-size:0.65rem;color:var(--dim);margin-bottom:0.75rem}

/* ── Cmd result ── */
.cmd-result{display:none;margin-top:0.5rem;padding:0.5rem 0.75rem;font-size:0.7rem;border-radius:2px;white-space:pre-wrap;word-break:break-word}
.cmd-result.show{display:block}
.cmd-result.loading{color:var(--info);background:rgba(108,140,255,0.08)}
.cmd-result.success{color:var(--ok);background:rgba(0,255,102,0.08)}
.cmd-result.error{color:var(--err);background:rgba(255,51,51,0.08)}

/* ── Filter ── */
.filter-input{background:var(--surface);border:1px solid var(--border);color:var(--text);padding:0.35rem 0.75rem;font-size:0.7rem;font-family:inherit;border-radius:2px;outline:none}
.filter-input:focus{border-color:var(--accent)}

/* ── Section headers ── */
.section-header{font-size:0.6rem;text-transform:uppercase;letter-spacing:0.15em;color:var(--dim);margin:1.5rem 0 0.75rem;padding-bottom:0.5rem;border-bottom:1px solid var(--border)}

/* ── Spinner ── */
.spinner{display:inline-block;width:1.2rem;height:1.2rem;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── Quake Console ── */
#qconsole{position:fixed;top:0;left:0;right:0;height:50vh;background:rgba(8,8,12,0.97);backdrop-filter:blur(5px);border-bottom:2px solid var(--accent);z-index:1000;display:flex;flex-direction:column;font-size:0.72rem;transform:translateY(-100%);transition:transform .25s cubic-bezier(.4,0,.2,1)}
#qconsole.open{transform:translateY(0)}
#qconsole-header{display:flex;justify-content:space-between;padding:0.4rem 1rem;border-bottom:1px solid var(--border);color:var(--accent);font-weight:700;font-size:0.65rem}
#qconsole-output{flex:1;overflow-y:auto;padding:0.6rem 1rem;line-height:1.6}
#qconsole-input-row{display:flex;align-items:center;gap:0.5rem;padding:0.4rem 1rem;border-top:1px solid var(--border);background:var(--surface)}
#qconsole-input{flex:1;background:transparent;border:none;outline:none;color:var(--text);font-family:inherit;font-size:inherit}
.q-accent{color:var(--accent)}.q-warn{color:var(--warn)}.q-err{color:var(--err)}.q-ok{color:var(--ok)}.q-info{color:var(--info)}.q-cmd{color:var(--accent);font-weight:700}

/* ── Animations ── */
@keyframes threshold-flicker{0%,20%,40%,60%,80%,100%{opacity:1}10%,30%,50%,70%,90%{opacity:.6}}
.threshold-flicker{animation:threshold-flicker .8s ease-in-out}
@keyframes glitch{0%{text-shadow:2px 0 var(--err),-2px 0 var(--info)}25%{text-shadow:-2px 0 var(--err),2px 0 var(--info)}50%{text-shadow:1px -1px var(--err),-1px 1px var(--info)}75%{text-shadow:-1px 1px var(--err),1px -1px var(--info)}100%{text-shadow:none}}
.logo:hover{animation:glitch .3s ease-in-out}

/* ── Scrollbar ── */
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--dim)}

/* ── Rate limit ── */
.rate-limit-box{background:var(--surface);border:1px solid var(--warn);border-radius:2px;padding:1.5rem;text-align:center}
.rate-limit-icon{font-size:2rem;color:var(--warn);margin-bottom:0.5rem}
.rate-limit-title{font-size:0.85rem;font-weight:700;color:var(--warn);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:0.5rem}
.rate-limit-msg{font-size:0.75rem;color:var(--text);margin-bottom:0.5rem}
.rate-limit-cooldown{font-size:0.65rem;color:var(--dim)}

/* ── Review cards (Signals panel compact) ── */
.review-card{background:var(--surface);border:1px solid var(--border);border-radius:2px;padding:0.75rem 1rem;margin-bottom:0.5rem;transition:border-color .15s}
.review-card:hover{border-color:var(--border-accent)}
.review-header{display:flex;align-items:center;gap:0.5rem;font-size:0.8rem;margin-bottom:0.35rem}
.review-title{font-size:0.75rem;color:var(--text);margin-bottom:0.25rem}
.review-summary{font-size:0.7rem;color:var(--dim);line-height:1.5;margin-bottom:0.35rem}
.review-meta{font-size:0.6rem;color:var(--dim)}

/* ── Reviews tab ── */
.reviews-toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem}
.review-entry{background:var(--surface);border:1px solid var(--border);border-radius:2px;margin-bottom:0.35rem;transition:border-color .15s}
.review-entry:hover{border-color:var(--border-accent)}
.review-entry-header{display:flex;align-items:center;gap:0.75rem;padding:0.6rem 0.8rem;cursor:pointer;user-select:none}
.review-entry-info{flex:1;min-width:0}
.review-entry-title{font-size:0.8rem;display:flex;align-items:center;gap:0.4rem;flex-wrap:wrap}
.review-entry-title a{color:var(--accent);text-decoration:none}
.review-entry-title a:hover{text-decoration:underline}
.review-entry-subtitle{font-size:0.7rem;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:0.15rem}
.review-entry-meta{display:flex;flex-direction:column;align-items:flex-end;gap:0.15rem;font-size:0.65rem;white-space:nowrap}
.review-chevron{font-size:0.6rem;color:var(--dim);transition:transform .15s}
.review-entry:has(.review-detail.open) .review-chevron{transform:rotate(180deg)}
.verdict-icon{font-size:1.1rem;width:1.6rem;height:1.6rem;display:flex;align-items:center;justify-content:center;border-radius:2px;flex-shrink:0}
.verdict-approve{color:var(--green);background:rgba(0,200,0,0.08)}
.verdict-minor{color:var(--yellow);background:rgba(200,200,0,0.08)}
.verdict-major{color:var(--red);background:rgba(200,0,0,0.08)}
.verdict-unknown{color:var(--dim);background:rgba(128,128,128,0.08)}
.review-detail{display:none;padding:0 0.8rem 0.8rem;border-top:1px solid var(--border)}
.review-detail.open{display:block}
.review-detail-summary{font-size:0.75rem;color:var(--text);padding:0.6rem 0;line-height:1.5}
.review-detail-body{font-size:0.7rem;color:var(--dim);background:var(--bg);border:1px solid var(--border);border-radius:2px;padding:0.8rem;max-height:20rem;overflow-y:auto;line-height:1.6;margin-bottom:0.6rem;white-space:pre-wrap}
.review-detail-actions{padding-top:0.4rem}
.review-retrigger{display:flex;gap:0.4rem;align-items:center}
.review-action-status{font-size:0.7rem;margin-top:0.3rem}
.review-action-status.loading{color:var(--yellow)}
.review-action-status.success{color:var(--green)}
.review-action-status.error{color:var(--red)}
.empty-state{text-align:center;padding:4rem 2rem;color:var(--dim)}
.empty-icon{font-size:2rem;margin-bottom:0.5rem;opacity:0.4}
.empty-title{font-size:1rem;color:var(--text);margin-bottom:0.5rem}
.empty-text{font-size:0.8rem;line-height:1.6}
.empty-text code{color:var(--accent);background:var(--surface);padding:0.1rem 0.3rem;border-radius:2px}

/* ── Reviews stats banner ── */
.reviews-stats-banner{display:grid;grid-template-columns:repeat(6,1fr);gap:0.5rem;margin-bottom:1rem}
.reviews-stats-banner .stat-card{text-align:center;padding:0.6rem 0.4rem}
.stat-green .stat-value{color:var(--green)}
.stat-yellow .stat-value{color:var(--yellow)}
.stat-red .stat-value{color:var(--red)}

/* ── Reviews table ── */
#reviews-table{width:100%}
#reviews-table th{font-size:0.6rem;text-transform:uppercase;letter-spacing:0.08em;padding:0.4rem 0.5rem;cursor:pointer;user-select:none;white-space:nowrap}
#reviews-table td{font-size:0.75rem;padding:0.45rem 0.5rem;vertical-align:middle}
#reviews-table .review-row{cursor:pointer;transition:background .1s}
#reviews-table .review-row:hover{background:var(--surface2)}
.review-row-title{max-width:18rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.review-detail-row{background:var(--surface)}
.review-detail-inner{padding:0.8rem}
.reviews-load-more{text-align:center;padding:1rem 0}
@media(max-width:768px){.reviews-stats-banner{grid-template-columns:repeat(3,1fr)}}

/* ── Insights ── */
.insights-toggle{display:flex;gap:0.35rem;align-items:center}
.insights-toggle button{background:transparent;border:1px solid var(--border);color:var(--dim);padding:0.25rem 0.6rem;font-size:0.6rem;font-family:inherit;cursor:pointer;border-radius:2px;text-transform:uppercase;letter-spacing:0.05em;transition:border-color .15s,color .15s}
.insights-toggle button:hover{border-color:var(--text);color:var(--text)}
.insights-toggle button.active{border-color:var(--accent);color:var(--accent)}
.insights-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0.75rem}
.insight-section{background:var(--surface);border:1px solid var(--border);border-radius:2px;padding:0.8rem 1rem}
.insight-section:hover{border-color:var(--border-accent)}
.insight-section-title{font-size:0.6rem;text-transform:uppercase;letter-spacing:0.12em;color:var(--accent);font-weight:700;margin-bottom:0.6rem;padding-bottom:0.35rem;border-bottom:1px solid var(--border)}
.insight-wide{grid-column:1/-1}
.insight-stats{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:0.4rem}
.insight-stat{text-align:center;padding:0.35rem}
.insight-stat-value{font-size:1.3rem;font-weight:700;color:var(--accent)}
.insight-stat-label{font-size:0.5rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--dim);margin-top:0.15rem}
.insight-bar-row{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.3rem}
.insight-bar-label{font-size:0.6rem;color:var(--dim);width:5.5rem;text-align:right;text-transform:uppercase;letter-spacing:0.04em;flex-shrink:0}
.insight-bar-track{flex:1;height:6px;background:var(--surface2);border-radius:1px;overflow:hidden}
.insight-bar-fill{height:100%;border-radius:1px;transition:width .4s ease}
.insight-bar-value{font-size:0.7rem;color:var(--text);width:2rem;text-align:right;font-weight:600;flex-shrink:0}
.insight-total{font-size:0.6rem;color:var(--dim);margin-top:0.5rem;text-align:right}
.insight-note{font-size:0.65rem;color:var(--dim);margin-top:0.6rem;padding:0.4rem 0.6rem;background:var(--surface2);border-radius:2px;border-left:2px solid var(--accent)}
.insight-repo-row{display:flex;align-items:center;gap:0.5rem;margin-bottom:0.25rem}
.insight-repo-name{font-size:0.7rem;color:var(--text);width:8rem;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0}
.insight-repo-stats{font-size:0.6rem;color:var(--dim);white-space:nowrap;flex-shrink:0}
.insight-models{display:flex;flex-wrap:wrap;gap:0.35rem}
.insight-model{background:var(--surface2);border:1px solid var(--border);border-radius:2px;padding:0.15rem 0.5rem;font-size:0.6rem;color:var(--text)}
.spark-chart{display:flex;align-items:flex-end;gap:0.25rem;height:3.5rem;padding-top:0.3rem}
.spark-col{flex:1;display:flex;flex-direction:column;align-items:center;height:100%}
.spark-bar{width:100%;background:var(--accent);border-radius:1px 1px 0 0;margin-top:auto;min-height:2px;transition:height .3s}
.spark-label{font-size:0.45rem;color:var(--dim);margin-top:0.15rem;white-space:nowrap}

/* ── Responsive ── */
@media(max-width:768px){.stat-grid{grid-template-columns:repeat(2,1fr)}.policy-grid{grid-template-columns:1fr}.nav-tabs{overflow-x:auto}.main-content{padding:1rem}}
`;

// ── Main HTML ────────────────────────────────────────────────────────

// ── Review Insights ──────────────────────────────────────────────────
function computeReviewInsights() {
  let reviews;
  try { reviews = getReviews({ limit: 100 }); } catch { reviews = []; }
  if (!reviews.length) return null;

  const now = Date.now();
  const oneDay = 86400000;
  const oneWeek = 7 * oneDay;

  const total = reviews.length;
  const repoSet = [...new Set(reviews.map(r => r.repo))];
  const authorSet = [...new Set(reviews.map(r => r.author).filter(Boolean))];
  const prSet = [...new Set(reviews.map(r => r.repo + '#' + r.pr))];

  // Verdict distribution
  const verdicts = { approve: 0, minor: 0, major: 0, unknown: 0 };
  reviews.forEach(r => { verdicts[r.assessment || 'unknown']++; });

  // Findings stats
  const totalFindings = reviews.reduce((s, r) => s + (r.findings || 0), 0);
  const avgFindings = total > 0 ? (totalFindings / total).toFixed(1) : '0';
  const withFindings = reviews.filter(r => r.findings > 0).length;
  const findingRate = total > 0 ? Math.round((withFindings / total) * 100) : 0;

  // Parse finding types from body markdown
  let criticals = 0, warnings = 0, suggestions = 0;
  reviews.forEach(r => {
    if (!r.body) return;
    criticals += (r.body.match(/\*\*\[critical\]\*\*/gi) || []).length;
    warnings += (r.body.match(/\*\*\[warning\]\*\*/gi) || []).length;
    suggestions += (r.body.match(/\*\*\[suggestion\]\*\*/gi) || []).length;
  });

  // Per-repo breakdown
  const repoMap = {};
  reviews.forEach(r => {
    if (!repoMap[r.repo]) repoMap[r.repo] = { reviews: 0, findings: 0, approves: 0, majors: 0, minors: 0 };
    const rs = repoMap[r.repo];
    rs.reviews++;
    rs.findings += (r.findings || 0);
    if (r.assessment === 'approve') rs.approves++;
    if (r.assessment === 'major') rs.majors++;
    if (r.assessment === 'minor') rs.minors++;
  });

  const repoBreakdown = Object.entries(repoMap)
    .map(([name, s]) => ({
      name, reviews: s.reviews, findings: s.findings,
      avgFindings: s.reviews > 0 ? (s.findings / s.reviews).toFixed(1) : '0',
      approveRate: s.reviews > 0 ? Math.round((s.approves / s.reviews) * 100) : 0,
      majors: s.majors, minors: s.minors,
    }))
    .sort((a, b) => b.findings - a.findings);

  // Time-based: reviews per week
  const weekBuckets = {};
  reviews.forEach(r => {
    if (!r.timestamp) return;
    const d = new Date(r.timestamp);
    const ws = new Date(d); ws.setDate(d.getDate() - d.getDay());
    const key = ws.toISOString().slice(0, 10);
    if (!weekBuckets[key]) weekBuckets[key] = { count: 0, findings: 0 };
    weekBuckets[key].count++;
    weekBuckets[key].findings += (r.findings || 0);
  });

  // Recent activity
  const last7d = reviews.filter(r => r.timestamp && (now - new Date(r.timestamp).getTime()) < oneWeek).length;
  const last30d = reviews.filter(r => r.timestamp && (now - new Date(r.timestamp).getTime()) < 30 * oneDay).length;

  // Model usage
  const models = {};
  reviews.forEach(r => { const m = r.model || 'unknown'; models[m] = (models[m] || 0) + 1; });

  // Actionability: % with actual findings
  const actionable = total > 0 ? Math.round((withFindings / total) * 100) : 0;

  // Severity breakdown as % of total findings
  const severityTotal = criticals + warnings + suggestions;

  return {
    total, repos: repoSet.length, authors: authorSet.length, uniquePRs: prSet.length,
    verdicts, totalFindings, avgFindings: parseFloat(avgFindings), withFindings, findingRate,
    criticals, warnings, suggestions, severityTotal,
    repoBreakdown, weekBuckets,
    last7d, last30d,
    actionable, models,
  };
}

function renderInsightsPartial() {
  const i = computeReviewInsights();
  if (!i) {
    return '<div class="empty-state"><div class="empty-icon">&#9670;</div>' +
      '<div class="empty-title">No review data yet</div>' +
      '<div class="empty-text">Insights will appear once AI reviews have been recorded.</div></div>';
  }

  // Helper: horizontal bar
  function bar(label, count, max, color) {
    const pct = max > 0 ? Math.round((count / max) * 100) : 0;
    return '<div class="insight-bar-row">' +
      '<span class="insight-bar-label">' + esc(label) + '</span>' +
      '<div class="insight-bar-track"><div class="insight-bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div>' +
      '<span class="insight-bar-value">' + count + '</span>' +
    '</div>';
  }

  const maxVerdict = Math.max(i.verdicts.approve, i.verdicts.minor, i.verdicts.major, i.verdicts.unknown, 1);
  const maxFinding = Math.max(i.criticals, i.warnings, i.suggestions, 1);
  const maxRepoFindings = i.repoBreakdown.length > 0 ? Math.max(...i.repoBreakdown.map(r => r.findings), 1) : 1;

  // Repo breakdown rows
  const repoRows = i.repoBreakdown.slice(0, 12).map(r => {
    const pct = Math.round((r.findings / maxRepoFindings) * 100);
    return '<div class="insight-repo-row">' +
      '<span class="insight-repo-name">' + esc(r.name) + '</span>' +
      '<div class="insight-bar-track" style="flex:1"><div class="insight-bar-fill" style="width:' + pct + '%;background:var(--accent)"></div></div>' +
      '<span class="insight-repo-stats">' + r.findings + ' / ' + r.reviews + ' reviews (avg ' + r.avgFindings + ')</span>' +
    '</div>';
  }).join('');

  // Weekly activity sparkline (last 8 weeks, CSS-only)
  const weekKeys = Object.keys(i.weekBuckets).sort().slice(-8);
  const maxWeek = weekKeys.length > 0 ? Math.max(...weekKeys.map(k => i.weekBuckets[k].count), 1) : 1;
  const weekBars = weekKeys.map(k => {
    const wk = i.weekBuckets[k];
    const h = Math.max(Math.round((wk.count / maxWeek) * 100), 4);
    const label = k.slice(5); // MM-DD
    return '<div class="spark-col" title="Week of ' + esc(k) + ': ' + wk.count + ' reviews, ' + wk.findings + ' findings">' +
      '<div class="spark-bar" style="height:' + h + '%"></div>' +
      '<div class="spark-label">' + label + '</div>' +
    '</div>';
  }).join('');

  // Model chips
  const modelChips = Object.entries(i.models).map(([name, count]) =>
    '<span class="insight-model">' + esc(name) + ': ' + count + '</span>'
  ).join('');

  // Effectiveness assessment
  let effectivenessNote = '';
  if (i.total >= 5) {
    if (i.actionable >= 60) effectivenessNote = 'High signal — ' + i.actionable + '% of reviews found actionable issues.';
    else if (i.actionable >= 30) effectivenessNote = 'Moderate signal — ' + i.actionable + '% of reviews found issues. Consider raising model temperature or using a larger model.';
    else effectivenessNote = 'Low signal — only ' + i.actionable + '% of reviews found issues. Review prompt tuning or model selection.';
  }

  return '<div class="insights-grid">' +

    // Overview stats
    '<div class="insight-section insight-wide">' +
      '<div class="insight-section-title">Review Activity</div>' +
      '<div class="insight-stats">' +
        '<div class="insight-stat"><div class="insight-stat-value">' + i.total + '</div><div class="insight-stat-label">Total Reviews</div></div>' +
        '<div class="insight-stat"><div class="insight-stat-value">' + i.repos + '</div><div class="insight-stat-label">Repos Covered</div></div>' +
        '<div class="insight-stat"><div class="insight-stat-value">' + i.uniquePRs + '</div><div class="insight-stat-label">Unique PRs</div></div>' +
        '<div class="insight-stat"><div class="insight-stat-value">' + i.avgFindings + '</div><div class="insight-stat-label">Avg Findings</div></div>' +
        '<div class="insight-stat"><div class="insight-stat-value">' + i.actionable + '%</div><div class="insight-stat-label">Find Rate</div></div>' +
        '<div class="insight-stat"><div class="insight-stat-value">' + i.last7d + '</div><div class="insight-stat-label">Last 7d</div></div>' +
      '</div>' +
      (effectivenessNote ? '<div class="insight-note">' + esc(effectivenessNote) + '</div>' : '') +
    '</div>' +

    // Verdict distribution
    '<div class="insight-section">' +
      '<div class="insight-section-title">Verdict Distribution</div>' +
      bar('Approve', i.verdicts.approve, maxVerdict, 'var(--ok)') +
      bar('Minor', i.verdicts.minor, maxVerdict, 'var(--warn)') +
      bar('Major', i.verdicts.major, maxVerdict, 'var(--err)') +
      bar('No Verdict', i.verdicts.unknown, maxVerdict, 'var(--dim)') +
    '</div>' +

    // Finding severity
    '<div class="insight-section">' +
      '<div class="insight-section-title">Finding Severity</div>' +
      bar('Critical', i.criticals, maxFinding, 'var(--err)') +
      bar('Warning', i.warnings, maxFinding, 'var(--warn)') +
      bar('Suggestion', i.suggestions, maxFinding, 'var(--info)') +
      '<div class="insight-total">' + i.totalFindings + ' total findings across ' + i.total + ' reviews</div>' +
    '</div>' +

    // Weekly sparkline
    (weekBars ? '<div class="insight-section">' +
      '<div class="insight-section-title">Weekly Activity</div>' +
      '<div class="spark-chart">' + weekBars + '</div>' +
    '</div>' : '') +

    // Repo breakdown
    '<div class="insight-section insight-wide">' +
      '<div class="insight-section-title">Findings by Repository</div>' +
      (repoRows || '<div class="dim">No repo data</div>') +
    '</div>' +

    // Model usage
    '<div class="insight-section">' +
      '<div class="insight-section-title">Model Usage</div>' +
      '<div class="insight-models">' + (modelChips || '<span class="dim">No data</span>') + '</div>' +
    '</div>' +

  '</div>';
}

function renderDashboardPage() {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>TEMPER</title>\n' +
    '<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'%3E%3Crect width=\'32\' height=\'32\' rx=\'4\' fill=\'%230a0a0f\'/%3E%3Cpath d=\'M6 8h20v2H6zM10 14h12v2H10zM8 20h16v2H8z\' fill=\'%23c8ff00\'/%3E%3Ccircle cx=\'24\' cy=\'9\' r=\'2\' fill=\'%23ff3366\'/%3E%3C/svg%3E">\n' +
    '<script src="/dashboard/htmx.js"></script>\n' +
    '<script src="/dashboard/idiomorph.js"></script>\n' +
    '<style>' + CSS + '</style>\n' +
    '</head>\n' +
    '<body hx-ext="morph">\n' +

    // Quake Console
    '<div id="qconsole">' +
      '<div id="qconsole-header"><span>TEMPER CONSOLE</span><span>` to toggle</span></div>' +
      '<div id="qconsole-output"></div>' +
      '<div id="qconsole-input-row"><span class="q-accent">&gt;</span><input id="qconsole-input" type="text" autocomplete="off" spellcheck="false" placeholder="command..." /></div>' +
    '</div>\n' +

    // Top navbar
    '<nav class="topnav">' +
      '<div class="logo">TEMPER</div>' +
      '<div class="nav-tabs">' +
        '<div class="nav-tab tab-active" data-nav="signals" onclick="switchPanel(\'signals\')">Signals <span class="tab-badge" id="nav-badge-prs">...</span></div>' +
        '<div class="nav-tab" data-nav="reviews" onclick="switchPanel(\'reviews\')">Reviews <span class="tab-badge" id="nav-badge-reviews">...</span></div>' +
        '<div class="nav-tab" data-nav="state" onclick="switchPanel(\'state\')">State <span class="tab-badge" id="nav-badge-repos">...</span></div>' +
        '<div class="nav-tab" data-nav="firestarter" onclick="switchPanel(\'firestarter\')">Firestarter</div>' +
        '<div class="nav-tab" data-nav="control" onclick="switchPanel(\'control\')">Control</div>' +
        '<div class="nav-tab" data-nav="commands" onclick="switchPanel(\'commands\')">Commands</div>' +
      '</div>' +
      '<div class="nav-right">' +
        '<span class="nav-status"><span class="spinner" id="poll-indicator" style="width:0.7rem;height:0.7rem;border-width:1.5px;display:none"></span> webhook + 10m poll</span>' +
        '<button class="cmd-btn-ghost" onclick="runCmd(\'refresh\',\'global-result\')">REFRESH</button>' +
        '<div id="global-result" class="cmd-result"></div>' +
      '</div>' +
    '</nav>\n' +

    // Main content
    '<main class="main-content">\n' +

    // Signals panel
    '<div id="panel-signals" class="panel active">' +
      '<div id="summary-section" hx-get="/dashboard/partials/summary" hx-trigger="load, every 600s" hx-swap="morph:innerHTML" hx-indicator="#poll-indicator">' +
        '<div style="text-align:center;padding:3rem"><span class="spinner"></span></div>' +
      '</div>' +
      '<div class="section-header">Active Pull Requests</div>' +
      '<div id="overview-prs" hx-get="/dashboard/partials/prs" hx-trigger="load, every 600s" hx-swap="morph:innerHTML" hx-indicator="#poll-indicator">' +
        '<div style="text-align:center;padding:2rem"><span class="spinner"></span></div>' +
      '</div>' +
    '</div>\n' +

    // Reviews panel (dedicated tab)
    '<div id="panel-reviews" class="panel">' +
      '<div class="reviews-toolbar">' +
        '<div class="section-header" style="margin:0">AI Code Reviews</div>' +
        '<div style="display:flex;gap:0.5rem;align-items:center">' +
          '<div class="insights-toggle">' +
            '<button class="active" onclick="toggleInsightsView(false)">Reviews</button>' +
            '<button onclick="toggleInsightsView(true)">Insights</button>' +
          '</div>' +
          '<input class="filter-input" data-filter="reviews-table" placeholder="filter by repo, PR, assessment..." style="width:14rem" />' +
        '</div>' +
      '</div>' +
      '<div id="insights-section" style="display:none" hx-get="/dashboard/partials/insights" hx-trigger="load, insightsLoad" hx-swap="morph:innerHTML">' +
        '<div style="text-align:center;padding:3rem"><span class="spinner"></span></div>' +
      '</div>' +
      '<div id="reviews-list" hx-get="/dashboard/partials/reviews-full" hx-trigger="load, every 120s" hx-swap="morph:innerHTML">' +
        '<div style="text-align:center;padding:3rem"><span class="spinner"></span></div>' +
      '</div>' +
    '</div>\n' +

    // State panel
    '<div id="panel-state" class="panel">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">' +
        '<div style="display:flex;gap:0.5rem">' +
          '<button class="cmd-btn" onclick="runCmd(\'sync\',\'sync-result\')">SYNC ALL</button>' +
          '<button class="cmd-btn-ghost" onclick="runCmd(\'refresh\',\'refresh-result2\')">REFRESH</button>' +
        '</div>' +
        '<input class="filter-input" data-filter="repos-table" placeholder="filter..." />' +
      '</div>' +
      '<div id="sync-result" class="cmd-result"></div>' +
      '<div id="refresh-result2" class="cmd-result"></div>' +
      '<div id="repos-section" hx-get="/dashboard/partials/repos" hx-trigger="load, every 600s" hx-swap="morph:innerHTML" hx-indicator="#poll-indicator">' +
        '<div style="text-align:center;padding:3rem"><span class="spinner"></span></div>' +
      '</div>' +
    '</div>\n' +

    // Firestarter panel
    '<div id="panel-firestarter" class="panel">' +
      '<input class="filter-input" data-filter="prs-section" placeholder="filter..." style="margin-bottom:1rem" />' +
      '<div id="prs-section" hx-get="/dashboard/partials/prs" hx-trigger="load, every 600s" hx-swap="morph:innerHTML" hx-indicator="#poll-indicator">' +
        '<div style="text-align:center;padding:3rem"><span class="spinner"></span></div>' +
      '</div>' +
    '</div>\n' +

    // Control panel (policy + issues)
    '<div id="panel-control" class="panel">' +
      '<div class="section-header">Governance Policy</div>' +
      '<div id="policy-section" hx-get="/dashboard/partials/policy" hx-trigger="load, every 600s" hx-swap="morph:innerHTML" hx-indicator="#poll-indicator">' +
        '<div style="text-align:center;padding:2rem"><span class="spinner"></span></div>' +
      '</div>' +
      '<div class="section-header" style="margin-top:2rem">Compliance Issues</div>' +
      '<div style="margin-bottom:0.5rem"><button class="cmd-btn" onclick="runCmd(\'sync\',\'issues-sync-result\')">FIX: SYNC ALL</button></div>' +
      '<div id="issues-sync-result" class="cmd-result"></div>' +
      '<div id="issues-section" hx-get="/dashboard/partials/issues" hx-trigger="load, every 600s" hx-swap="morph:innerHTML" hx-indicator="#poll-indicator">' +
        '<div style="text-align:center;padding:2rem"><span class="spinner"></span></div>' +
      '</div>' +
    '</div>\n' +

    // Commands panel
    '<div id="panel-commands" class="panel">' +
      '<div class="cmd-grid">' +
        '<div class="cmd-card"><h3>Sync All Repositories</h3><p>Apply config.yml governance to all org repos.</p>' +
          '<button class="cmd-btn" onclick="runCmd(\'sync\',\'cmd-sync\')">RUN</button><div id="cmd-sync" class="cmd-result"></div></div>' +
        '<div class="cmd-card"><h3>Check Config</h3><p>Compare actual settings against governance policy.</p>' +
          '<button class="cmd-btn" onclick="runCmd(\'check-config\',\'cmd-config\')">RUN</button><div id="cmd-config" class="cmd-result"></div></div>' +
        '<div class="cmd-card"><h3>Check Dependabot</h3><p>Audit dependabot configs across all repos.</p>' +
          '<button class="cmd-btn" onclick="runCmd(\'check-dependabot\',\'cmd-dep\')">RUN</button><div id="cmd-dep" class="cmd-result"></div></div>' +
        '<div class="cmd-card"><h3>Fix Dependabot Labels</h3><p>Fix missing labels on dependabot PRs.</p>' +
          '<button class="cmd-btn" onclick="runCmd(\'fix-dependabot-labels\',\'cmd-fix\')">RUN</button><div id="cmd-fix" class="cmd-result"></div></div>' +
        '<div class="cmd-card"><h3>Analyze Organization</h3><p>Full org-wide analysis report.</p>' +
          '<button class="cmd-btn" onclick="runCmd(\'analyze-org\',\'cmd-analyze\')">RUN</button><div id="cmd-analyze" class="cmd-result"></div></div>' +
        '<div class="cmd-card"><h3>Refresh Cache</h3><p>Invalidate cache and re-fetch all data from GitHub API.</p>' +
          '<button class="cmd-btn-ghost" onclick="runCmd(\'refresh\',\'cmd-refresh\')">RUN</button><div id="cmd-refresh" class="cmd-result"></div></div>' +
      '</div>' +
    '</div>\n' +

    '</main>\n' +
    '<script src="/dashboard/app.js"></script>\n' +
    '</body>\n</html>';
}

// ── Request handler ──────────────────────────────────────────────────
function sendHtml(res, s, html) { res.writeHead(s, {'Content-Type':'text/html; charset=utf-8'}); res.end(html); }
function sendJson(res, s, obj) { res.writeHead(s, {'Content-Type':'application/json'}); res.end(JSON.stringify(obj)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; if (data.length > 1e6) { req.destroy(); reject(new Error('Body too large')); } });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
function redirect(res, loc) { res.writeHead(302, {'Location':loc}); res.end(); }

export function createDashboardHandler() {
  return async (req, res) => {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const path = url.pathname;

    if (req.method === 'GET' && (path === '/' || path === '')) { redirect(res, '/dashboard'); return true; }
    if (req.method === 'GET' && path === '/dashboard') { sendHtml(res, 200, renderDashboardPage()); return true; }

    // Self-hosted static assets
    if (req.method === 'GET' && path === '/dashboard/app.js') {
      res.writeHead(200, {'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'public, max-age=60'});
      res.end(CLIENT_JS);
      return true;
    }
    if (req.method === 'GET' && path === '/dashboard/htmx.js') {
      res.writeHead(200, {'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'public, max-age=86400'});
      res.end(HTMX_JS);
      return true;
    }
    if (req.method === 'GET' && path === '/dashboard/idiomorph.js') {
      res.writeHead(200, {'Content-Type':'application/javascript; charset=utf-8','Cache-Control':'public, max-age=86400'});
      res.end(IDIOMORPH_JS);
      return true;
    }

    // Error formatter with rate limit awareness
    function renderError(err) {
      if (err.isRateLimit) {
        return '<div class="rate-limit-box">' +
          '<div class="rate-limit-icon">&#9888;</div>' +
          '<div class="rate-limit-title">GitHub API Rate Limit</div>' +
          '<div class="rate-limit-msg">' + esc(err.message) + '</div>' +
          '<div class="rate-limit-cooldown">Auto-retry when limit resets. Cached data will be served when available.</div>' +
        '</div>';
      }
      return '<div class="alert alert-err">' + esc(err.message || 'Error loading data') + '</div>';
    }

    // Partials — always return 200 so HTMX swaps the content (error HTML is still displayable)
    if (req.method === 'GET' && path === '/dashboard/partials/summary') {
      try { sendHtml(res, 200, renderSummaryPartial(await fetchOrgData())); }
      catch (err) { getLogger().error({err},'Dashboard summary error'); sendHtml(res, 200, renderError(err)); }
      return true;
    }
    if (req.method === 'GET' && path === '/dashboard/partials/repos') {
      try { sendHtml(res, 200, renderReposPartial(await fetchOrgData())); }
      catch (err) { getLogger().error({err},'Dashboard repos error'); sendHtml(res, 200, renderError(err)); }
      return true;
    }
    if (req.method === 'GET' && path === '/dashboard/partials/prs') {
      try { sendHtml(res, 200, renderPRsPartial(await fetchOrgData())); }
      catch (err) { getLogger().error({err},'Dashboard PRs error'); sendHtml(res, 200, renderError(err)); }
      return true;
    }
    if (req.method === 'GET' && path === '/dashboard/partials/policy') {
      try { sendHtml(res, 200, renderPolicyPartial(await fetchOrgData())); }
      catch (err) { getLogger().error({err},'Dashboard policy error'); sendHtml(res, 200, renderError(err)); }
      return true;
    }
    if (req.method === 'GET' && path === '/dashboard/partials/issues') {
      try { sendHtml(res, 200, renderIssuesPartial(await fetchOrgData())); }
      catch (err) { getLogger().error({err},'Dashboard issues error'); sendHtml(res, 200, renderError(err)); }
      return true;
    }

    // AI Reviews partial (compact, for Signals panel if still used)
    if (req.method === 'GET' && path === '/dashboard/partials/reviews') {
      try { sendHtml(res, 200, renderReviewsPartial()); }
      catch (err) { getLogger().error({err},'Dashboard reviews error'); sendHtml(res, 200, renderError(err)); }
      return true;
    }

    // Review Insights partial
    if (req.method === 'GET' && path === '/dashboard/partials/insights') {
      try { sendHtml(res, 200, renderInsightsPartial()); }
      catch (err) { getLogger().error({err},'Dashboard insights error'); sendHtml(res, 200, renderError(err)); }
      return true;
    }

    // AI Reviews full partial (for dedicated Reviews tab)
    if (req.method === 'GET' && path === '/dashboard/partials/reviews-full') {
      try { sendHtml(res, 200, renderReviewsFullPartial(req.url)); }
      catch (err) { getLogger().error({err},'Dashboard reviews-full error'); sendHtml(res, 200, renderError(err)); }
      return true;
    }
    // AI Reviews "load more" partial (appends rows)
    if (req.method === 'GET' && path === '/dashboard/partials/reviews-more') {
      try { sendHtml(res, 200, renderReviewsMorePartial(req.url)); }
      catch (err) { getLogger().error({err},'Dashboard reviews-more error'); sendHtml(res, 200, renderError(err)); }
      return true;
    }

    // JSON APIs
    if (req.method === 'GET' && path === '/api/org/health') {
      try { const d = await fetchOrgData(); sendJson(res, 200, {success:true, ...d.summary, timestamp:d.timestamp}); }
      catch (err) { sendJson(res, 500, {success:false, error:err.message}); }
      return true;
    }
    if (req.method === 'GET' && path === '/api/reviews/insights') {
      try {
        const insights = computeReviewInsights();
        sendJson(res, 200, { success: true, insights: insights || {} });
      } catch (err) { sendJson(res, 500, { success: false, error: err.message }); }
      return true;
    }
    if (req.method === 'GET' && path === '/api/org/repos') {
      try { const d = await fetchOrgData(); sendJson(res, 200, {success:true, repos:d.repos}); }
      catch (err) { sendJson(res, 500, {success:false, error:err.message}); }
      return true;
    }

    // Actions
    if (req.method === 'POST' && path === '/dashboard/actions/refresh') {
      invalidateCache();
      try { await fetchOrgData(); sendJson(res, 200, {success:true, message:'Cache refreshed.'}); }
      catch (err) { sendJson(res, 500, {success:false, message:err.message}); }
      return true;
    }
    if (req.method === 'POST' && path === '/dashboard/actions/sync') {
      try {
        const octokit = await getOctokit();
        const org = getConfig()?.organization || 'pulseengine';
        const result = await synchronizeAllRepositories(octokit, org);
        invalidateCache();
        sendJson(res, 200, {success:result.success, message: result.success ? 'Synchronized ' + result.repositoriesProcessed + ' repositories.' : result.error});
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
        const data = await fetchOrgData();
        const results = [];
        for (const repo of data.repos) {
          const report = await checkDependabotConfiguration(octokit, org, repo.name);
          results.push('## ' + repo.name + '\n' + report);
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
        sendJson(res, 200, {success:true, message: totalFixed > 0 ? 'Fixed labels on ' + totalFixed + ' PRs.' : 'No label issues found.'});
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

    // Trigger AI review from dashboard
    if (req.method === 'POST' && path === '/dashboard/actions/review') {
      try {
        const body = await readBody(req);
        const { repo, pr, instructions } = JSON.parse(body);
        if (!repo || !pr) {
          sendJson(res, 400, { success: false, message: 'Missing repo or pr number' });
          return true;
        }
        const octokit = await getOctokit();
        const org = getConfig()?.organization || 'pulseengine';
        // Fire and forget — the review takes 2-3 minutes on CPU
        reviewPullRequest(octokit, org, repo, pr, instructions || '')
          .then(result => {
            getLogger().info({ repo, pr, success: result.success }, 'Dashboard-triggered review completed');
          })
          .catch(err => {
            getLogger().error({ repo, pr, err: err.message }, 'Dashboard-triggered review failed');
          });
        sendJson(res, 200, { success: true, message: `Review triggered for ${repo} #${pr}. It will take 2-3 minutes.` });
      } catch (err) { sendJson(res, 500, { success: false, message: err.message }); }
      return true;
    }

    return false;
  };
}
