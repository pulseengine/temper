/**
 * Org standards: one definition of "intended", one drift function, one apply.
 *
 *   snapshot  — everything GitHub reports about a repo's enforcement state
 *               (repo settings, classic protection, every ruleset in full,
 *               the effective rules on the default branch, workflow files).
 *   evaluate  — snapshot × standards → findings (rule / intended / actual /
 *               drift / how it gets fixed). Pure; the dashboard, the CLI and
 *               the dry-run all read this, so there is no second definition.
 *   enforce   — the writes that close the auto-fixable drift. The dry-run runs
 *               this exact function against an octokit that records writes
 *               instead of sending them, so the plan is what apply would do.
 *
 * What the rules mean (config.yml `standards:` documents the knobs):
 *   required_checks      a non-empty set of required status checks that binds
 *                        admins (rule 1: never merge around red).
 *   no_bypass            classic protection has enforce_admins, and no ruleset
 *                        on the default branch lists bypass actors (rule 1).
 *   required_signatures  signed commits on the default branch (rule 2).
 *   update_branch        "Always suggest updating PR branches" off; strict
 *                        up-to-date off on merge-queue repos (rule 3).
 *   hostname_scan        the hostname-scan stub is present and required (rule 4).
 *   tag_protection       an active tag ruleset covers release tags (rule 5).
 *   pull_request, merge_queue, merge_methods, auto_merge  supporting settings.
 */

import fs from 'fs';
import path from 'path';
import { getLogger } from './logger.js';
import { createConfigurationPR } from './github-api.js';
import {
  ensureRepositoryRuleset,
  translateBranchProtectionToRuleset,
  TEMPER_RULESET_NAME
} from './rulesets.js';

export const TEMPER_TAG_IMMUTABLE_NAME = 'temper-release-tags-immutable';
export const TEMPER_TAG_CREATE_NAME = 'temper-release-tags-create';
import { SHA_RE } from './standards-schema.js';

export { validateStandards } from './standards-schema.js';

// RepositoryRole 5 is the built-in "admin" role.
const DEFAULT_TAG_CREATE_BYPASS = [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }];

export function getStandards(config = {}) {
  const s = config?.standards || {};
  const tp = s.tag_protection || {};
  return {
    enabled: s.enabled === true,
    include_forks: s.include_forks === true,
    required_signatures: s.required_signatures !== false,
    no_bypass: s.no_bypass !== false,
    fix_foreign_bypass: s.fix_foreign_bypass !== false,
    require_status_checks: s.require_status_checks !== false,
    require_pull_request: s.require_pull_request !== false,
    merge_queue_repos: s.merge_queue?.repos || [],
    queue_strict: s.merge_queue?.strict_up_to_date ?? false,
    merge: config?.settings?.merge || {},
    tag_protection: {
      enabled: tp.enabled !== false,
      include: tp.include || ['refs/tags/v*'],
      immutable_name: tp.immutable_name || TEMPER_TAG_IMMUTABLE_NAME,
      create_name: tp.create_name || TEMPER_TAG_CREATE_NAME,
      create_bypass_actors: tp.create_bypass_actors || DEFAULT_TAG_CREATE_BYPASS
    },
    required_workflows: s.required_workflows || [],
    repos: s.repos || {},
    managed_ruleset_name: config?.rulesets?.name || TEMPER_RULESET_NAME
  };
}

// ── Snapshot ────────────────────────────────────────────────────────────────

async function getWithStatus(octokit, route, params) {
  try {
    const res = await octokit.request(route, params);
    return { status: res.status || 200, body: res.data };
  } catch (err) {
    return { status: err.status || 0, body: { message: err.message } };
  }
}

/** Fetch a repo's enforcement snapshot (read-only). */
export async function fetchSnapshot(octokit, owner, name) {
  const repo = await getWithStatus(octokit, 'GET /repos/{owner}/{repo}', { owner, repo: name });
  const branch = repo.body?.default_branch || 'main';
  const p = { owner, repo: name, branch };
  const protection = await getWithStatus(octokit, 'GET /repos/{owner}/{repo}/branches/{branch}/protection', p);
  const branchRules = await getWithStatus(octokit, 'GET /repos/{owner}/{repo}/rules/branches/{branch}', {
    ...p,
    per_page: 100
  });
  const list = await getWithStatus(octokit, 'GET /repos/{owner}/{repo}/rulesets', {
    owner,
    repo: name,
    includes_parents: true,
    per_page: 100
  });
  const items = [];
  if (list.status === 200 && Array.isArray(list.body)) {
    for (const rs of list.body) {
      const full = await getWithStatus(octokit, 'GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
        owner,
        repo: name,
        ruleset_id: rs.id
      });
      items.push(full.status === 200 ? full.body : { ...rs, _fetch_status: full.status });
    }
  }
  const workflows = await getWithStatus(octokit, 'GET /repos/{owner}/{repo}/contents/{path}', {
    owner,
    repo: name,
    path: '.github/workflows',
    ref: branch
  });
  return {
    name,
    owner,
    repo,
    protection,
    branchRules,
    rulesets: { status: list.status, body: list.status === 200 ? undefined : list.body, items },
    workflows
  };
}

/**
 * Load a snapshot from a sweep cache directory (one dir per repo holding
 * repo.json, protection.json, branch_rules.json, rulesets_list.json,
 * ruleset_<id>.json, workflows.json — each `{status, body}`). Lets the
 * evaluation run offline on data gathered by any read-only sweep.
 */
export function loadSnapshotDir(dir, owner = 'pulseengine') {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const list = read('rulesets_list.json');
  const items = list.status === 200 ? (list.body || []).map((r) => {
    const f = `ruleset_${r.id}.json`;
    if (!fs.existsSync(path.join(dir, f))) return { ...r, _fetch_status: 0 };
    const full = read(f);
    return full.status === 200 ? full.body : { ...r, _fetch_status: full.status };
  }) : [];
  return {
    name: path.basename(dir),
    owner,
    repo: read('repo.json'),
    protection: read('protection.json'),
    branchRules: read('branch_rules.json'),
    rulesets: { status: list.status, body: list.status === 200 ? undefined : list.body, items },
    workflows: read('workflows.json')
  };
}

// ── Derivation ──────────────────────────────────────────────────────────────

const uniq = (xs) => [...new Set(xs)];

function globToRegExp(glob) {
  const esc = (part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp('^' + glob.split('**').map(esc).join('.*') + '$');
}

function tagRulesetCovers(rs, sampleRef) {
  const inc = rs?.conditions?.ref_name?.include || [];
  const exc = rs?.conditions?.ref_name?.exclude || [];
  const hit = (pats) => pats.some((p) => p === '~ALL' || globToRegExp(p).test(sampleRef));
  return hit(inc) && !hit(exc);
}

/** Facts derived from a snapshot, independent of what is intended. */
export function deriveState(snap) {
  const repo = snap.repo?.body || {};
  const prot = snap.protection?.status === 200 ? snap.protection.body : null;
  const rules = snap.branchRules?.status === 200 && Array.isArray(snap.branchRules.body) ? snap.branchRules.body : [];
  const rulesets = snap.rulesets?.items || [];
  const ruleTypes = new Set(rules.map((r) => r.type));
  const applyingIds = new Set(rules.map((r) => r.ruleset_id).filter((x) => x !== undefined));
  const branchRulesets = rulesets.filter((r) => applyingIds.has(r.id));

  const legacyContexts = prot
    ? uniq([
        ...(prot.required_status_checks?.contexts || []),
        ...(prot.required_status_checks?.checks || []).map((c) => c.context)
      ])
    : [];
  const enforceAdmins = prot ? prot.enforce_admins?.enabled === true : null;

  const bypassOf = (rs) => (Array.isArray(rs.bypass_actors) ? rs.bypass_actors : null);
  const rulesetBypass = branchRulesets
    .filter((rs) => (bypassOf(rs) === null ? true : bypassOf(rs).length > 0))
    .map((rs) => ({
      id: rs.id,
      name: rs.name,
      source_type: rs.source_type,
      actors: bypassOf(rs),
      current_user_can_bypass: rs.current_user_can_bypass
    }));
  const bypassIds = new Set(rulesetBypass.map((b) => b.id));

  const rulesetContexts = [];
  const bindingRulesetContexts = [];
  let rulesetStrict = false;
  for (const r of rules.filter((x) => x.type === 'required_status_checks')) {
    const ctxs = (r.parameters?.required_status_checks || []).map((c) => c.context);
    rulesetContexts.push(...ctxs);
    if (!bypassIds.has(r.ruleset_id)) bindingRulesetContexts.push(...ctxs);
    if (r.parameters?.strict_required_status_checks_policy) rulesetStrict = true;
  }
  const bindingContexts = uniq([...(enforceAdmins ? legacyContexts : []), ...bindingRulesetContexts]);

  const workflowFiles =
    snap.workflows?.status === 200 && Array.isArray(snap.workflows.body)
      ? snap.workflows.body.map((f) => f.path || `.github/workflows/${f.name}`)
      : [];

  // Active branch rulesets whose ref include list is empty match no branch:
  // they look like protection in the UI but enforce nothing.
  const inertRulesets = rulesets
    .filter((r) => (r.target || 'branch') === 'branch' && r.enforcement === 'active' &&
      Array.isArray(r.conditions?.ref_name?.include) && r.conditions.ref_name.include.length === 0)
    .map((r) => r.name);
  const tagRulesets = rulesets.filter((r) => r.target === 'tag');
  // Release tags are protected when (a) an active, bypass-free ruleset makes
  // them immutable (update + deletion) and (b) an active ruleset restricts
  // their creation — whose bypass list IS the allowlist of who may tag.
  const coveringTags = tagRulesets.filter((r) => r.enforcement === 'active' && tagRulesetCovers(r, 'refs/tags/v1.0.0'));
  const ruleIn = (r, t) => (r.rules || []).some((x) => x.type === t);
  const releaseTagsImmutable = coveringTags.some(
    (r) => Array.isArray(r.bypass_actors) && r.bypass_actors.length === 0 && ruleIn(r, 'update') && ruleIn(r, 'deletion')
  );
  const releaseTagCreateRestricted = coveringTags.some((r) => ruleIn(r, 'creation'));

  const forbidden = [snap.protection, snap.rulesets].some(
    (x) => x?.status === 403 && /upgrade to github pro|make this repository public/i.test(x?.body?.message || '')
  );

  return {
    name: snap.name,
    branch: repo.default_branch || 'main',
    private: repo.private === true,
    fork: repo.fork === true,
    archived: repo.archived === true,
    planBlocked: forbidden,
    protectionStatus: snap.protection?.status,
    hasLegacy: Boolean(prot),
    enforceAdmins,
    legacyContexts,
    legacyStrict: prot ? prot.required_status_checks?.strict === true : false,
    legacySignatures: prot ? prot.required_signatures?.enabled === true : false,
    legacyPullRequest: prot ? Boolean(prot.required_pull_request_reviews) : false,
    legacyLinear: prot ? prot.required_linear_history?.enabled === true : false,
    ruleTypes: [...ruleTypes].sort(),
    rulesetContexts: uniq(rulesetContexts),
    bindingContexts,
    allContexts: uniq([...legacyContexts, ...rulesetContexts]),
    rulesetStrict,
    rulesetBypass,
    inertRulesets,
    branchRulesets: branchRulesets.map((r) => ({ id: r.id, name: r.name, source_type: r.source_type })),
    mergeQueue: ruleTypes.has('merge_queue'),
    signatures: (prot ? prot.required_signatures?.enabled === true : false) || ruleTypes.has('required_signatures'),
    pullRequest: (prot ? Boolean(prot.required_pull_request_reviews) : false) || ruleTypes.has('pull_request'),
    linearHistory: (prot ? prot.required_linear_history?.enabled === true : false) || ruleTypes.has('required_linear_history'),
    workflowFiles,
    tagRulesets: tagRulesets.map((r) => ({
      id: r.id,
      name: r.name,
      enforcement: r.enforcement,
      include: r.conditions?.ref_name?.include || [],
      rules: (r.rules || []).map((x) => x.type),
      bypass_actors: r.bypass_actors ?? null
    })),
    releaseTagsImmutable,
    releaseTagCreateRestricted,
    settings: {
      allow_merge_commit: repo.allow_merge_commit,
      allow_squash_merge: repo.allow_squash_merge,
      allow_rebase_merge: repo.allow_rebase_merge,
      allow_auto_merge: repo.allow_auto_merge,
      allow_update_branch: repo.allow_update_branch,
      delete_branch_on_merge: repo.delete_branch_on_merge
    }
  };
}

// ── Evaluation ──────────────────────────────────────────────────────────────

/** The required-status-check contexts temper intends for a repo. */
export function intendedContexts(state, std) {
  const override = std.repos?.[state.name]?.required_checks;
  const base = Array.isArray(override) ? override : state.allContexts;
  const wf = std.required_workflows
    .filter((w) => state.workflowFiles.includes(w.path))
    .map((w) => w.context);
  return uniq([...base, ...wf]);
}

function finding(rule, intended, actual, drift, fix = null, note = '') {
  return { rule, intended, actual, drift, fix: drift ? fix : null, note };
}

const fmt = (v) => (v === undefined || v === null ? 'unknown' : String(v));

/**
 * Evaluate one repo snapshot against the standards.
 * `fix` is 'auto' (temper apply closes it), 'owner' (a decision or a name
 * temper cannot invent), or 'blocked' (a precondition is missing).
 */
export function evaluateRepo(snap, std) {
  const st = deriveState(snap);
  const out = { repo: st.name, scope: 'enforced', blocker: null, findings: [], state: st };

  if (st.archived) {
    out.scope = 'archived';
    return out;
  }
  if (st.fork && !std.include_forks) {
    out.scope = 'fork';
    out.blocker = 'fork of an upstream project: excluded from the floor (standards.include_forks: false)';
    return out;
  }
  const f = out.findings;
  const queue = std.merge_queue_repos.includes(st.name);
  // A repo whose own automation the floor would break: report, never enforce.
  const hold = std.repos?.[st.name]?.report_only;
  if (hold) {
    out.scope = 'held';
    out.blocker = `report-only: ${hold}`;
  }

  // Repo settings work on every plan, so they are evaluated even when blocked.
  const m = std.merge;
  for (const key of ['allow_merge_commit', 'allow_squash_merge', 'allow_rebase_merge']) {
    if (m[key] !== undefined) {
      f.push(finding('merge_methods', `${key}=${m[key]}`, `${key}=${fmt(st.settings[key])}`, st.settings[key] !== m[key], 'auto'));
    }
  }
  if (m.allow_auto_merge !== undefined) {
    f.push(finding('auto_merge', fmt(m.allow_auto_merge), fmt(st.settings.allow_auto_merge),
      st.settings.allow_auto_merge !== m.allow_auto_merge, st.planBlocked ? 'blocked' : 'auto',
      st.planBlocked ? 'auto-merge on a private repo needs a paid plan' : ''));
  }
  if (m.allow_update_branch !== undefined) {
    f.push(finding('update_branch', `allow_update_branch=${m.allow_update_branch}`,
      `allow_update_branch=${fmt(st.settings.allow_update_branch)}`,
      st.settings.allow_update_branch !== m.allow_update_branch, 'auto'));
  }

  if (st.planBlocked) {
    out.scope = 'unenforceable';
    out.blocker = 'private repo on GitHub Free: branch protection and rulesets return 403';
    return out;
  }

  const contexts = intendedContexts(st, std);
  if (std.require_status_checks) {
    const empty = st.allContexts.length === 0;
    f.push(finding('required_checks',
      contexts.length ? `non-empty, binding (${contexts.length})` : 'non-empty, binding',
      empty ? 'none' : `${st.allContexts.length} required, ${st.bindingContexts.length} binding admins`,
      contexts.length === 0 || st.bindingContexts.length < contexts.length,
      contexts.length === 0 ? 'owner' : 'auto',
      contexts.length === 0 ? 'no required checks to carry over: owner must name them (standards.repos.<repo>.required_checks)' : ''));
  }

  if (std.no_bypass) {
    const legacyBypass = st.hasLegacy && st.enforceAdmins !== true;
    const parts = [];
    if (st.hasLegacy) parts.push(`enforce_admins=${fmt(st.enforceAdmins)}`);
    for (const b of st.rulesetBypass) {
      const who = b.actors === null ? 'unknown actors' : b.actors.map((a) => `${a.actor_type}:${a.actor_id ?? '-'}/${a.bypass_mode}`).join(',');
      parts.push(`ruleset "${b.name}" bypass=${who}`);
    }
    const foreign = st.rulesetBypass.filter((b) => b.name !== std.managed_ruleset_name);
    f.push(finding('no_bypass', 'enforce_admins=true, no bypass actors',
      parts.join('; ') || 'no classic protection, no bypass actors',
      legacyBypass || st.rulesetBypass.length > 0,
      foreign.some((b) => b.source_type && b.source_type !== 'Repository') ? 'owner'
        : (foreign.length && !std.fix_foreign_bypass ? 'owner' : 'auto'),
      st.inertRulesets.length ? `inert ruleset(s) matching no branch: ${st.inertRulesets.map((n) => `"${n}"`).join(', ')}` : ''));
  }

  if (std.required_signatures) {
    f.push(finding('required_signatures', 'true', fmt(st.signatures), !st.signatures, 'auto'));
  }
  if (std.require_pull_request) {
    f.push(finding('pull_request', 'true', fmt(st.pullRequest), !st.pullRequest, 'auto'));
  }

  // Strict up-to-date is only switched off where a queue actually runs: the
  // queue is what re-tests against the latest main. Elsewhere temper keeps the
  // repo's current strictness (turning it on costs ~N^2/2 CI runs; turning it
  // off without a queue merges PRs never tested against main).
  const strictActual = st.legacyStrict || st.rulesetStrict;
  if (st.mergeQueue && (st.allContexts.length > 0 || contexts.length > 0)) {
    const want = std.queue_strict;
    f.push(finding('update_branch', `strict_up_to_date=${want} (queue repo)`,
      `strict_up_to_date=${strictActual}`, strictActual !== want,
      st.rulesetStrict ? 'owner' : 'auto',
      strictActual ? 'the queue already tests against the latest main; strict only adds update-branch pressure' : ''));
  } else if (queue && strictActual) {
    f.push(finding('update_branch', 'strict_up_to_date=false once the queue is live',
      'strict_up_to_date=true (no queue yet)', false, null, 'switch strict off in the same change that turns the queue on'));
  }

  f.push(finding('merge_queue', queue ? 'present' : 'not required', st.mergeQueue ? 'present' : 'absent',
    queue && !st.mergeQueue, 'owner',
    queue && !st.mergeQueue ? 'per-repo rollout: every required workflow needs a merge_group trigger first' : ''));

  for (const wf of std.required_workflows) {
    const present = st.workflowFiles.includes(wf.path);
    const required = st.allContexts.includes(wf.context);
    const pinned = SHA_RE.test(String(wf.pin || ''));
    f.push(finding(wf.name, 'stub present and required', `stub ${present ? 'present' : 'absent'}, ${required ? 'required' : 'not required'}`,
      !present || !required, !present && !pinned ? 'blocked' : 'auto',
      !present && !pinned ? `standards.required_workflows "${wf.name}".pin is unset (pin to a merged temper sha)` : ''));
  }

  if (std.tag_protection.enabled) {
    const desc = st.tagRulesets.length
      ? st.tagRulesets.map((t) => `"${t.name}" ${t.enforcement} [${t.include.join(',')}] rules=${t.rules.join('+')}`).join('; ')
      : 'none';
    const missing = [!st.releaseTagsImmutable && 'immutable (update+deletion, no bypass)',
      !st.releaseTagCreateRestricted && 'creation restricted'].filter(Boolean);
    f.push(finding('tag_protection', `${std.tag_protection.include.join(',')}: immutable + creation restricted`,
      desc, missing.length > 0, 'auto', missing.length ? `missing: ${missing.join('; ')}` : ''));
  }

  return out;
}

export function hasDrift(evaluation) {
  return evaluation.findings.some((x) => x.drift);
}

// ── Enforcement ─────────────────────────────────────────────────────────────

/** Release tags can never be moved or deleted — by anyone. */
export function buildTagImmutableRuleset(std) {
  return {
    name: std.tag_protection.immutable_name,
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: std.tag_protection.include, exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'update' }],
    bypass_actors: []
  };
}

/** Only the bypass list (default: repo admins) may create release tags. */
export function buildTagCreateRuleset(std) {
  return {
    name: std.tag_protection.create_name,
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: std.tag_protection.include, exclude: [] } },
    rules: [{ type: 'creation' }],
    bypass_actors: std.tag_protection.create_bypass_actors
  };
}

export function buildManagedRuleset(protectionConfig, state, std) {
  const contexts = intendedContexts(state, std);
  const strict = state.mergeQueue ? std.queue_strict : state.legacyStrict || state.rulesetStrict;
  return translateBranchProtectionToRuleset(
    {
      ...protectionConfig,
      require_signed_commits: std.required_signatures || protectionConfig.require_signed_commits,
      required_status_checks: {
        strict,
        contexts
      }
    },
    std.managed_ruleset_name
  );
}

export function renderWorkflowTemplate(text, { pin, defaultBranch }) {
  return text.replace(/__TEMPER_PIN__/g, pin).replace(/__TEMPER_DEFAULT_BRANCH__/g, defaultBranch);
}

/**
 * Close the auto-fixable drift for one repo. Never replaces classic protection
 * wholesale (that would wipe per-repo contexts); every legacy change uses the
 * narrow sub-resource endpoint.
 *
 * @returns {Promise<string[]>} human-readable list of actions taken
 */
export async function enforceStandards(octokit, owner, protectionConfig, snap, std, { readTemplate } = {}) {
  const evaluation = evaluateRepo(snap, std);
  const st = evaluation.state;
  const repo = st.name;
  const branch = st.branch;
  const done = [];
  if (evaluation.scope !== 'enforced') return { evaluation, actions: done };

  if (st.hasLegacy) {
    if (std.no_bypass && st.enforceAdmins !== true) {
      await octokit.request('POST /repos/{owner}/{repo}/branches/{branch}/protection/enforce_admins', { owner, repo, branch });
      done.push('classic protection: enforce_admins on');
    }
    if (std.required_signatures && !st.legacySignatures) {
      await octokit.request('POST /repos/{owner}/{repo}/branches/{branch}/protection/required_signatures', { owner, repo, branch });
      done.push('classic protection: required_signatures on');
    }
    if (st.mergeQueue && st.legacyStrict && std.queue_strict === false) {
      await octokit.request('PATCH /repos/{owner}/{repo}/branches/{branch}/protection/required_status_checks', {
        owner, repo, branch, strict: false
      });
      done.push('classic protection: strict up-to-date off (merge-queue repo)');
    }
  }

  const managed = buildManagedRuleset(protectionConfig, st, std);
  const r = await ensureRepositoryRuleset(octokit, owner, repo, managed);
  if (r.action !== 'unchanged') done.push(`ruleset "${managed.name}": ${r.action}`);

  if (std.no_bypass && std.fix_foreign_bypass) {
    for (const b of st.rulesetBypass) {
      if (b.name === std.managed_ruleset_name || (b.source_type && b.source_type !== 'Repository')) continue;
      const full = (snap.rulesets.items || []).find((x) => x.id === b.id);
      await octokit.request('PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}', {
        owner,
        repo,
        ruleset_id: b.id,
        name: full.name,
        target: full.target,
        enforcement: full.enforcement,
        conditions: full.conditions,
        rules: full.rules,
        bypass_actors: []
      });
      done.push(`ruleset "${b.name}": bypass actors removed`);
    }
  }

  if (std.tag_protection.enabled) {
    const wanted = [
      !st.releaseTagsImmutable && buildTagImmutableRuleset(std),
      !st.releaseTagCreateRestricted && buildTagCreateRuleset(std)
    ].filter(Boolean);
    for (const desired of wanted) {
      const t = await ensureRepositoryRuleset(octokit, owner, repo, desired);
      if (t.action !== 'unchanged') done.push(`ruleset "${desired.name}": ${t.action}`);
    }
  }

  for (const wf of std.required_workflows) {
    if (st.workflowFiles.includes(wf.path)) continue;
    if (!SHA_RE.test(String(wf.pin || ''))) {
      getLogger().info(`Skipping ${wf.name} stub for ${owner}/${repo}: pin unset`);
      continue;
    }
    const content = renderWorkflowTemplate(readTemplate(wf.template), { pin: wf.pin, defaultBranch: branch });
    await createConfigurationPR(octokit, owner, repo, wf.path, content, `ci: add ${wf.name} (temper standard)`);
    done.push(`PR: add ${wf.path}`);
  }

  return { evaluation, actions: done };
}
