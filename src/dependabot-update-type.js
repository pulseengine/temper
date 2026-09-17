/**
 * Decide whether a Dependabot PR may be auto-merged, from what it updates.
 *
 * Policy (maintainer decision, temper#71): auto-merge non-breaking updates
 * only. A breaking update waits for a human.
 *
 * Why it cannot be left to CI. For a library, a green PR is decent evidence
 * a bump works. For a workflow action it can be none at all: on
 * pulseengine/varve, `setup-oras` runs only in a `workflow_dispatch` deposit
 * workflow and `cosign sign-blob` only in a tag-triggered release, so a major
 * bump to either goes green without its changed code ever executing — and
 * the first failure lands after a release is tagged.
 *
 * Why the decision is conservative. Anything that cannot be read as semver —
 * an unrecognised title, a SHA-only action update — is REFUSED, not assumed
 * safe. The cost of a false refusal is a human clicking merge; the cost of a
 * false allow is an unreviewed breaking change in someone's release path.
 */

/**
 * Parse a version out of a Dependabot token into [major, minor, patch].
 * Returns null when the token is not a version.
 *
 * Handles the shapes Dependabot actually writes: build metadata
 * (`0.9.12+spec-1.1.0`), requirement operators (`>=1.2.0`), one-component
 * versions (`4`), a leading `v`, and the full stop ending a `Bumps` line.
 */
export function parseVersion(token) {
  if (typeof token !== 'string') return null;
  const core = token
    .trim()
    .replace(/\.$/, '')
    .replace(/^[<>=^~v\s]+/, '')
    .split('+')[0]
    .split('-')[0];
  if (!/^\d+(\.\d+){0,2}$/.test(core)) return null;
  const parts = core.split('.').map(Number);
  while (parts.length < 3) parts.push(0);
  return parts;
}

/**
 * Is moving from `a` to `b` a breaking change?
 *
 * Uses the leftmost-non-zero rule, which is what Cargo and npm caret ranges
 * mean by compatible: a major change is breaking; on a 0.x line a minor change
 * is breaking; on a 0.0.x line a patch change is. Treating `0.7 -> 0.8` as a
 * harmless minor would auto-merge exactly the Rust updates most likely to
 * break a build.
 */
export function isBreakingUpdate(a, b) {
  if (a[0] !== b[0]) return true;
  if (a[0] === 0 && a[1] !== b[1]) return true;
  if (a[0] === 0 && a[1] === 0 && a[2] !== b[2]) return true;
  return false;
}

// The three shapes Dependabot writes, each capturing the PACKAGE as well as
// the versions. The package is what makes two updates distinct: a grouped PR
// can move `wasmtime` and `wasmtime-wasi` from the same version to the same
// version, and keying on the versions alone collapses them into one.
const TITLE = /\b(?:bump|update)\s+(\S+?)(?:\s+requirement)?\s+from\s+(\S+)\s+to\s+(\S+)/i;
const UPDATES_LINE = /^Updates\s+`([^`]+)`\s+from\s+(\S+)\s+to\s+(\S+)/;
const BUMPS_LINE = /^Bumps\s+\[([^\]]+)\]\([^)]*\)\s+from\s+(\S+)\s+to\s+(\S+)/;

/**
 * Every update a Dependabot PR makes, as `{ name, from, to }`.
 *
 * Read from the title, and from the body ONLY on the summary lines Dependabot
 * writes itself (`Updates \`x\` from ...`, `Bumps [x](...) from ...`). The body
 * also quotes upstream release notes, which routinely say things like
 * "migrate from 2.0.0 to 9.0.0"; reading those would invent updates.
 *
 * A grouped PR's title names no versions, so its body lines are the only
 * source — and they must all be read, because a group's name says nothing
 * about what is in it (witness#211, "the wasmtime group", carries 47 -> 48).
 */
export function extractUpdates(title, body) {
  const updates = [];
  const seen = new Set();
  const add = (name, from, to) => {
    const clean = (v) => v.replace(/\.$/, '');
    const u = { name, from: clean(from), to: clean(to) };
    // A single-update PR states its update twice — in the title and in the
    // body's `Bumps` line. De-duplicate on package AND versions, so that
    // restatement collapses while two packages moving in step do not.
    const key = `${u.name}|${u.from}|${u.to}`;
    if (seen.has(key)) return;
    seen.add(key);
    updates.push(u);
  };

  const t = TITLE.exec(title || '');
  if (t) add(t[1], t[2], t[3]);

  for (const line of (body || '').split('\n')) {
    const trimmed = line.trim();
    const m = UPDATES_LINE.exec(trimmed) || BUMPS_LINE.exec(trimmed);
    if (m) add(m[1], m[2], m[3]);
  }
  return updates;
}

/**
 * The decision, with a reason a human can act on.
 *
 * @returns {{ allow: boolean, reason: string }}
 */
export function dependabotAutoMergeDecision(title, body) {
  const updates = extractUpdates(title, body);
  if (updates.length === 0) {
    return {
      allow: false,
      reason: 'could not read any version update from the PR, so its semver impact is unknown'
    };
  }
  for (const { name, from, to } of updates) {
    const a = parseVersion(from);
    const b = parseVersion(to);
    if (!a || !b) {
      return {
        allow: false,
        reason: `could not read ${name} "${from}" -> "${to}" as semver, so its impact is unknown`
      };
    }
    if (isBreakingUpdate(a, b)) {
      return {
        allow: false,
        reason: `breaking update ${name} ${from} -> ${to} needs a human review`
      };
    }
  }
  return { allow: true, reason: `${updates.length} non-breaking update(s)` };
}
