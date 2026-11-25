/**
 * Scoped sync: apply only the planned writes of the named repos and kinds.
 *
 * The plan is the apply. `planOrg` runs the real configureRepository against
 * the recording octokit; this module filters those recorded writes by repo
 * and kind and replays exactly them, call for call, on the real octokit. What
 * `plan --repo R --only K` prints is therefore what `sync --repo R --only K`
 * sends, and nothing outside the scope is ever requested.
 *
 * Only self-contained writes are replayable. A write whose arguments come
 * from an earlier write's response (configuration PRs: branch, blob, file,
 * PR) or that carries file content is refused here; the full org sync
 * remains the path for those.
 */

import { planOrg } from './plan.js';

export const WRITE_KINDS = Object.freeze([
  'merge', 'enforce_admins', 'signatures', 'branch_ruleset', 'tag_rulesets', 'labels'
]);

const ROUTE_KINDS = [
  [/^PATCH \/repos\/\{owner\}\/\{repo\}$/, 'merge'],
  [/^POST \/repos\/\{owner\}\/\{repo\}\/branches\/\{branch\}\/protection\/enforce_admins$/, 'enforce_admins'],
  [/^POST \/repos\/\{owner\}\/\{repo\}\/branches\/\{branch\}\/protection\/required_signatures$/, 'signatures'],
  [/^(POST \/repos\/\{owner\}\/\{repo\}\/rulesets|PUT \/repos\/\{owner\}\/\{repo\}\/rulesets\/\{ruleset_id\})$/, 'ruleset'],
  [/^(POST \/repos\/\{owner\}\/\{repo\}\/labels|PATCH \/repos\/\{owner\}\/\{repo\}\/labels\/\{name\})$/, 'labels']
];

/** The kind of one recorded write, or 'other' (not replayable). */
function routeKey(w) {
  return `${String(w?.method || '').toUpperCase()} ${String(w?.route || '').replace(/^[A-Z]+\s+/, '')}`;
}

export function writeKind(w) {
  const route = routeKey(w);
  for (const [re, kind] of ROUTE_KINDS) {
    if (!re.test(route)) continue;
    if (kind === 'ruleset') {
      if (w.body?.target === 'tag') return 'tag_rulesets';
      if (w.body?.target === 'branch') return 'branch_ruleset';
      return 'other';
    }
    return kind;
  }
  return 'other';
}

/** Parse --only; unknown kinds are an error, not a silent no-op. */
export function parseKinds(only) {
  if (only === null || only === undefined) return [...WRITE_KINDS];
  const kinds = String(only).split(',').map((k) => k.trim()).filter(Boolean);
  const unknown = kinds.filter((k) => !WRITE_KINDS.includes(k));
  if (unknown.length || kinds.length === 0) {
    throw new Error(`--only takes ${WRITE_KINDS.join(', ')}; got ${only}`);
  }
  return kinds;
}

/**
 * Split each repo's planned writes into the scoped set and the rest.
 * @returns {Array<{repo, scope, apply: object[], skipped: Array<{kind, write}>}>}
 */
export function scopePlan(results, kinds) {
  return results.map((r) => {
    const apply = [];
    const skipped = [];
    for (const w of r.writes || []) {
      const kind = writeKind(w);
      if (kinds.includes(kind)) apply.push({ ...w, kind });
      else skipped.push({ kind, write: w });
    }
    return { repo: r.repo, scope: r.scope, blocker: r.blocker || null, apply, skipped };
  });
}

function ownerRepo(url) {
  const m = /^\/repos\/([^/]+)\/([^/]+)/.exec(String(url));
  if (!m) throw new Error(`cannot replay ${url}: not a repository route`);
  return { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]) };
}

/** Replay one recorded write exactly as configureRepository made it. */
async function replay(octokit, w) {
  if (!WRITE_KINDS.includes(w.kind)) throw new Error(`refusing to replay ${w.method} ${w.url}: kind ${w.kind}`);
  if (w.body && Object.prototype.hasOwnProperty.call(w.body, 'content')) {
    throw new Error(`refusing to replay ${w.method} ${w.url}: it carries file content`);
  }
  const { owner, repo } = ownerRepo(w.url);
  const { method: _m, ...params } = w.body || {}; // eslint-disable-line no-unused-vars
  return octokit.request(routeKey(w), { ...params, owner, repo });
}

/**
 * Plan the named repos, then (unless dryRun) send exactly the scoped writes.
 * Repos outside `repos` are never planned, so never written. A repo whose
 * evaluation scope is not 'enforced' is not written either.
 *
 * @param {object} octokit - real octokit (reads for the plan, writes on apply)
 * @param {string} org
 * @param {object} opts
 * @param {string[]} opts.repos - required; ['*'] means every sync target
 * @param {string|null} [opts.only] - comma list of WRITE_KINDS
 * @param {boolean} [opts.dryRun]
 * @param {Function} [opts.planner] - injectable (tests)
 */
export async function scopedSync(octokit, org, { repos, only = null, dryRun = false, planner = planOrg, plannerOpts = {} } = {}) {
  if (!Array.isArray(repos) || repos.length === 0) throw new Error('scoped sync needs --repo a,b (or --repo "*")');
  const kinds = parseKinds(only);
  const all = repos.length === 1 && repos[0] === '*';
  const plan = await planner(octokit, org, { ...plannerOpts, repos: all ? null : repos });
  const scoped = scopePlan(plan.results.filter((r) => all || repos.includes(r.repo)), kinds);
  const missing = all ? [] : repos.filter((n) => !scoped.some((s) => s.repo === n));

  const applied = [];
  const failed = [];
  if (!dryRun) {
    for (const s of scoped) {
      if (s.scope !== 'enforced') continue;
      for (const w of s.apply) {
        try {
          await replay(octokit, w);
          applied.push({ repo: s.repo, kind: w.kind, method: w.method, url: w.url });
        } catch (e) {
          failed.push({ repo: s.repo, kind: w.kind, method: w.method, url: w.url, error: e.message });
          break; // stop this repo at its first failure; the re-run plan shows where it stands
        }
      }
    }
  }
  return { kinds, scoped, missing, applied, failed, dryRun };
}

/** Plain-text view of a scoped plan. */
export function renderScoped({ kinds, scoped, missing }) {
  const lines = [`scope: ${kinds.join(', ')}`];
  for (const s of scoped) {
    const held = s.scope !== 'enforced' ? ` (not applied: scope ${s.scope}${s.blocker ? `; ${s.blocker}` : ''})` : '';
    lines.push(`${s.repo}: ${s.apply.length} write(s) in scope, ${s.skipped.length} outside${held}`);
    for (const w of s.apply) lines.push(`   -> [${w.kind}] ${w.method} ${w.url} ${JSON.stringify(w.body)}`);
  }
  for (const m of missing) lines.push(`${m}: not a sync target (archived, unknown or excluded); nothing planned`);
  return lines.join('\n') + '\n';
}
