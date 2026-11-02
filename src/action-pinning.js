/**
 * Action SHA-pinning check (org rule: actions are referenced by commit SHA,
 * not by tag — `uses: owner/action@<sha> # vN`).
 *
 * Scans .github/workflows/*.yml for `uses:` lines pinned to a version tag
 * (e.g. @v7) instead of a 40-char commit SHA, and reports them.
 */

import { getLogger } from './logger.js';

const SHA_RE = /^[a-f0-9]{40}$/;
const USES_RE = /^\s*-?\s*uses:\s*([^\s@]+)@([^\s#]+)(?:\s*#\s*(.*))?\s*$/;

/**
 * List tag-pinned action references in a repo's workflows.
 * @param {object} octokit - GitHub API client
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<Array<{file: string, line: number, action: string, ref: string}>>}
 */
export async function findTagPinnedActions(octokit, owner, repo) {
  const findings = [];
  let files;
  try {
    const res = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: '.github/workflows'
    });
    files = (res.data || []).filter((f) => /\.ya?ml$/.test(f.name));
  } catch (error) {
    if (error.status === 404) return [];
    throw error;
  }

  for (const f of files) {
    try {
      const res = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: f.path
      });
      const content = Buffer.from(res.data.content, 'base64').toString('utf8');
      content.split('\n').forEach((line, i) => {
        const m = line.match(USES_RE);
        if (!m) return;
        const [, action, ref] = m;
        // Docker images (docker://) and local actions (./) are not SHA-pinnable.
        if (action.startsWith('docker://') || action.startsWith('./')) return;
        if (!SHA_RE.test(ref)) {
          findings.push({ file: f.name, line: i + 1, action, ref });
        }
      });
    } catch (error) {
      getLogger().warn(`action-pinning: could not read ${f.path} in ${owner}/${repo}: ${error.message}`);
    }
  }
  return findings;
}
