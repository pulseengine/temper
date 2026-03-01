#!/usr/bin/env node

import { config as dotenvConfig } from 'dotenv';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.join(__dirname, '..', '.env'), quiet: true });

// ── Octokit Setup ────────────────────────────────────────────────────
async function getOctokit() {
  const appId = process.env.APP_ID;
  const privateKey = (process.env.PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const org = process.env.ORGANIZATION || 'pulseengine';

  const appOctokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey }
  });

  const { data: installations } = await appOctokit.apps.listInstallations();
  const inst = installations.find(i => i.account?.login === org);
  if (!inst) throw new Error(`No installation found for org: ${org}`);

  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId: inst.id }
  });
}

// ── Formatting ───────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', blue: '\x1b[34m', gray: '\x1b[90m'
};

function ok(s) { return `${C.green}${s}${C.reset}`; }
function warn(s) { return `${C.yellow}${s}${C.reset}`; }
function err(s) { return `${C.red}${s}${C.reset}`; }
function dim(s) { return `${C.gray}${s}${C.reset}`; }
function bold(s) { return `${C.bold}${s}${C.reset}`; }

function padEnd(s, n) { return String(s).padEnd(n); }

// ── Analyze ──────────────────────────────────────────────────────────
async function analyzeOrg(octokit, org) {
  const repos = await octokit.paginate('GET /orgs/{org}/repos', {
    org, type: 'all', per_page: 100
  });

  const results = [];
  for (const repo of repos) {
    if (repo.archived || repo.fork) continue;

    const r = { name: repo.name, updated: repo.updated_at };

    // merge settings
    r.merge = {
      commit: repo.allow_merge_commit,
      squash: repo.allow_squash_merge,
      rebase: repo.allow_rebase_merge,
      deleteBranch: repo.delete_branch_on_merge
    };

    // branch protection
    try {
      const { data: bp } = await octokit.repos.getBranchProtection({
        owner: org, repo: repo.name, branch: repo.default_branch || 'main'
      });
      r.protection = {
        exists: true,
        checks: bp.required_status_checks?.contexts || [],
        enforceAdmins: bp.enforce_admins?.enabled,
        reviews: bp.required_pull_request_reviews?.required_approving_review_count || 0,
        signed: false
      };
      // Check signed commits separately
      try {
        await octokit.repos.getCommitSignatureProtection({
          owner: org, repo: repo.name, branch: repo.default_branch || 'main'
        });
        r.protection.signed = true;
      } catch { r.protection.signed = false; }
    } catch {
      r.protection = { exists: false, checks: [], enforceAdmins: false, reviews: 0, signed: false };
    }

    // CI status
    try {
      const { data: runs } = await octokit.actions.listWorkflowRunsForRepo({
        owner: org, repo: repo.name, per_page: 1
      });
      const run = runs.workflow_runs?.[0];
      r.ci = run ? (run.conclusion || run.status) : 'none';
    } catch { r.ci = 'none'; }

    results.push(r);
  }

  return results.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Commands ─────────────────────────────────────────────────────────
async function cmdOrgHealth(octokit, org) {
  console.log(bold(`\n  Temper — ${org} org health\n`));
  const repos = await analyzeOrg(octokit, org);

  const total = repos.length;
  const prot = repos.filter(r => r.protection.exists).length;
  const ci = repos.filter(r => r.ci !== 'none').length;
  const signed = repos.filter(r => r.protection.signed).length;
  const correctMerge = repos.filter(r => r.merge.rebase && !r.merge.commit && !r.merge.squash).length;
  const issues = repos.filter(r => !r.protection.exists || r.merge.commit || r.merge.squash || !r.merge.rebase);

  console.log(`  ${bold('Total repos:')}      ${total}`);
  console.log(`  ${bold('Protected:')}        ${prot === total ? ok(prot) : warn(prot)}/${total}`);
  console.log(`  ${bold('With CI:')}          ${ci > 0 ? ok(ci) : warn(ci)}/${total}`);
  console.log(`  ${bold('Signed commits:')}   ${signed}/${total}`);
  console.log(`  ${bold('Correct merge:')}    ${correctMerge === total ? ok(correctMerge) : warn(correctMerge)}/${total}`);
  console.log(`  ${bold('Issues:')}           ${issues.length === 0 ? ok('0') : err(issues.length)}`);

  if (issues.length > 0) {
    console.log(`\n  ${bold('Issues:')}`);
    issues.forEach(r => {
      const probs = [];
      if (!r.protection.exists) probs.push('no protection');
      if (r.merge.commit) probs.push('merge commit allowed');
      if (r.merge.squash) probs.push('squash allowed');
      if (!r.merge.rebase) probs.push('rebase disabled');
      console.log(`    ${warn(r.name)}: ${probs.join(', ')}`);
    });
  }
  console.log();
}

async function cmdOrgRepos(octokit, org) {
  console.log(bold(`\n  Temper — ${org} repositories\n`));
  const repos = await analyzeOrg(octokit, org);

  // Header
  console.log(`  ${dim(padEnd('REPOSITORY', 28))}${dim(padEnd('PROT', 6))}${dim(padEnd('ADMIN', 8))}${dim(padEnd('REVIEW', 8))}${dim(padEnd('CI', 12))}${dim(padEnd('MERGE', 14))}${dim('SIGNED')}`);
  console.log(`  ${dim('─'.repeat(84))}`);

  repos.forEach(r => {
    const prot = r.protection.exists ? ok('yes') : warn('no');
    const admin = r.protection.enforceAdmins ? warn('yes') : ok('no');
    const review = r.protection.reviews > 0 ? warn(r.protection.reviews) : ok('0');
    const ciMap = { success: ok('pass'), failure: err('fail'), none: dim('none') };
    const ci = ciMap[r.ci] || dim(r.ci);
    const merge = r.merge.rebase && !r.merge.commit && !r.merge.squash
      ? ok('rebase')
      : warn([r.merge.rebase && 'rebase', r.merge.commit && 'merge', r.merge.squash && 'squash'].filter(Boolean).join('+'));
    const signed = r.protection.signed ? ok('yes') : dim('no');

    console.log(`  ${C.cyan}${padEnd(r.name, 28)}${C.reset}${padEnd(prot, 16)}${padEnd(admin, 18)}${padEnd(review, 18)}${padEnd(ci, 22)}${padEnd(merge, 24)}${signed}`);
  });
  console.log();
}

async function cmdRepoCheck(octokit, org, repoName) {
  console.log(bold(`\n  Temper — ${org}/${repoName} check\n`));

  try {
    const { data: repo } = await octokit.repos.get({ owner: org, repo: repoName });

    console.log(`  ${bold('Merge settings:')}`);
    console.log(`    Merge commit:  ${repo.allow_merge_commit ? warn('enabled') : ok('disabled')}`);
    console.log(`    Squash merge:  ${repo.allow_squash_merge ? warn('enabled') : ok('disabled')}`);
    console.log(`    Rebase merge:  ${repo.allow_rebase_merge ? ok('enabled') : warn('disabled')}`);
    console.log(`    Delete branch: ${repo.delete_branch_on_merge ? ok('enabled') : warn('disabled')}`);

    const branch = repo.default_branch || 'main';
    console.log(`\n  ${bold('Branch protection:')} (${branch})`);
    try {
      const { data: bp } = await octokit.repos.getBranchProtection({
        owner: org, repo: repoName, branch
      });
      console.log(`    Status checks: ${(bp.required_status_checks?.contexts || []).join(', ') || dim('none')}`);
      console.log(`    Enforce admin: ${bp.enforce_admins?.enabled ? warn('yes') : ok('no')}`);
      console.log(`    Reviews:       ${bp.required_pull_request_reviews ? warn(bp.required_pull_request_reviews.required_approving_review_count) : ok('none')}`);

      try {
        await octokit.repos.getCommitSignatureProtection({ owner: org, repo: repoName, branch });
        console.log(`    Signed:        ${ok('required')}`);
      } catch { console.log(`    Signed:        ${dim('not required')}`); }
    } catch {
      console.log(`    ${warn('No branch protection configured')}`);
    }

    // CI
    console.log(`\n  ${bold('CI status:')}`);
    try {
      const { data: runs } = await octokit.actions.listWorkflowRunsForRepo({
        owner: org, repo: repoName, per_page: 3
      });
      if (runs.workflow_runs.length === 0) {
        console.log(`    ${dim('No workflow runs found')}`);
      } else {
        runs.workflow_runs.forEach(run => {
          const status = run.conclusion === 'success' ? ok('pass') : run.conclusion === 'failure' ? err('fail') : dim(run.conclusion || run.status);
          console.log(`    ${padEnd(run.name, 20)} ${status}  ${dim(run.updated_at)}`);
        });
      }
    } catch { console.log(`    ${dim('Could not fetch CI runs')}`); }
  } catch (e) {
    console.error(err(`  Error: ${e.message}`));
  }
  console.log();
}

async function cmdSync(octokit, org) {
  console.log(bold(`\n  Temper — syncing all repos in ${org}...\n`));

  const { synchronizeAllRepositories } = await import('../src/organization.js');
  const result = await synchronizeAllRepositories(octokit, org);

  if (result.success) {
    console.log(ok(`  Synchronized ${result.repositoriesProcessed} repositories\n`));
  } else {
    console.error(err(`  Sync failed: ${result.error}\n`));
  }
}

// ── Main ─────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const sub = args[1];

  if (!cmd) {
    console.log(`
  ${bold('Temper CLI')}

  Usage:
    node scripts/cli.js org health     Summary of all repos
    node scripts/cli.js org repos      Detailed per-repo table
    node scripts/cli.js repo check <n> Check a single repo
    node scripts/cli.js sync           Sync all repos to config
`);
    process.exit(0);
  }

  const org = process.env.ORGANIZATION || 'pulseengine';
  const octokit = await getOctokit();

  if (cmd === 'org' && sub === 'health') return cmdOrgHealth(octokit, org);
  if (cmd === 'org' && sub === 'repos') return cmdOrgRepos(octokit, org);
  if (cmd === 'repo' && sub === 'check') return cmdRepoCheck(octokit, org, args[2]);
  if (cmd === 'sync') return cmdSync(octokit, org);

  console.error(err(`Unknown command: ${cmd} ${sub || ''}`));
  process.exit(1);
}

main().catch(e => { console.error(err(e.message)); process.exit(1); });
