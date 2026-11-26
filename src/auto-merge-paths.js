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

/** Glob to RegExp: `*` matches within one path segment, nothing else is special. */
export function globToRegExp(glob) {
  const body = String(glob).split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*');
  return new RegExp(`^${body}$`);
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
 * Every file of a PR. Throws when GitHub's answer is not a file list, so a
 * caller that cannot see the files does not arm auto-merge.
 */
export async function listPullRequestFiles(octokit, owner, repo, pullNumber) {
  const files = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const res = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
      owner, repo, pull_number: pullNumber, per_page: 100, page
    });
    if (!Array.isArray(res?.data)) throw new Error('PR file list is not an array');
    files.push(...res.data);
    if (res.data.length < 100) break;
  }
  return files;
}
