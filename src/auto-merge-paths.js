/**
 * Paths that keep maintainer review: temper never arms auto-merge on a PR
 * that changes one of them (owner rule 2026-11-25, after relay#726, a grouped
 * Dependabot actions PR that touched release.yml). A green PR is no evidence
 * for a release workflow: it runs on a tag, not on the PR.
 */

export const DEFAULT_REVIEW_PATHS = [
  '.github/workflows/release*.yml',
  '.github/workflows/release*.yaml'
];

// GitHub returns at most 3000 files for a PR, 100 per page.
const MAX_PAGES = 30;

/**
 * Glob to RegExp: `*` matches within one path segment, nothing else is
 * special. Case-insensitive: GitHub runs .github/workflows/Release.yml too.
 */
export function globToRegExp(glob) {
  const body = String(glob).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return new RegExp(`^${body}$`, 'i');
}

/** The changed paths (including a rename's old path) that match a review pattern. */
export function reviewPathHits(files, patterns = DEFAULT_REVIEW_PATHS) {
  const res = patterns.map(globToRegExp);
  const hits = new Set();
  for (const f of files) {
    for (const p of [f.filename, f.previous_filename]) {
      if (typeof p === 'string' && res.some((re) => re.test(p))) hits.add(p);
    }
  }
  return [...hits].sort();
}

/**
 * Every file of a PR. Throws when GitHub's answer is not a file list, when
 * the list is cut at GitHub's 3000-file cap, or when it is shorter than the
 * PR's changed_files, so a caller that cannot see every file does not arm.
 */
export async function listPullRequestFiles(octokit, owner, repo, pullNumber, changedFiles) {
  const files = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
      owner, repo, pull_number: pullNumber, per_page: 100, page
    });
    if (!Array.isArray(res?.data)) throw new Error('PR file list is not an array');
    files.push(...res.data);
    if (res.data.length < 100) {
      if (Number.isInteger(changedFiles) && files.length < changedFiles) {
        throw new Error(`PR file list has ${files.length} of ${changedFiles} files`);
      }
      return files;
    }
  }
  throw new Error(`PR file list reaches GitHub's ${MAX_PAGES * 100}-file cap`);
}

/**
 * Whether `branch` has at least one required status check, from classic
 * protection or from an active ruleset. Without one, auto-merge merges the
 * moment it is armed, before CI runs. Throws when either source cannot be
 * read, so a caller that cannot tell does not arm.
 */
export async function hasRequiredChecks(octokit, owner, repo, branch) {
  const b = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', { owner, repo, branch });
  if (!b?.data || typeof b.data !== 'object') throw new Error('branch answer is not an object');
  const rsc = b.data.protection?.required_status_checks;
  if ((rsc?.contexts?.length || 0) + (rsc?.checks?.length || 0) > 0) return true;

  for (let page = 1; page <= 10; page += 1) {
    const r = await octokit.request('GET /repos/{owner}/{repo}/rules/branches/{branch}', {
      owner, repo, branch, per_page: 100, page
    });
    if (!Array.isArray(r?.data)) throw new Error('branch rules answer is not an array');
    if (r.data.some((rule) => rule?.type === 'required_status_checks' &&
      (rule.parameters?.required_status_checks?.length || 0) > 0)) return true;
    if (r.data.length < 100) return false;
  }
  throw new Error('branch rules exceed 1000 entries');
}
