/**
 * Counters the report needs that nothing else keeps: GitHub API calls in the
 * last hour (from the rate-limit headers of every response), and AI review
 * outcomes per UTC day. Both are in-memory unless a persistent KV store is
 * set, so a restart does not reset the review window.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// ── API calls ──────────────────────────────────────────────────────────────

let _calls = [];
let _rate = null; // { remaining, limit, reset_at_ms }

/** Record one API response (its headers carry the installation's budget). */
export function recordApiResponse(headers = {}, now = Date.now()) {
  _calls.push(now);
  const remaining = Number(headers['x-ratelimit-remaining']);
  const limit = Number(headers['x-ratelimit-limit']);
  const reset = Number(headers['x-ratelimit-reset']);
  if (Number.isFinite(remaining) && Number.isFinite(limit) && Number.isFinite(reset)) {
    _rate = { remaining, limit, reset_at_ms: reset * 1000 };
  }
}

/** Count every request an Octokit instance makes. Safe to call twice. */
export function trackOctokit(octokit) {
  if (!octokit?.hook || octokit.__temperTracked) return octokit;
  octokit.hook.after('request', (response) => recordApiResponse(response?.headers));
  octokit.hook.error('request', (error) => {
    recordApiResponse(error?.response?.headers);
    throw error;
  });
  Object.defineProperty(octokit, '__temperTracked', { value: true });
  return octokit;
}

/** { calls_last_hour, remaining, limit, reset_at_ms } — rate is null until a response was seen. */
export function apiSnapshot(now = Date.now()) {
  _calls = _calls.filter((t) => t > now - HOUR);
  return { calls_last_hour: _calls.length, rate: _rate };
}

// ── Review outcomes ────────────────────────────────────────────────────────

export const REVIEW_COUNTERS = ['posted', 'suppressed_no_findings', 'findings', 'dropped_unquoted', 'rivet_oracle_runs', 'errors'];
let _store = null;
const _mem = new Map();

/** Back the review counters with a persistent KV store ({get,set}). */
export function setReviewStatsStore(store) {
  _store = store;
}

const dayKey = (now) => new Date(now).toISOString().slice(0, 10);

function readDay(key) {
  const raw = _store ? _store.get(key) : _mem.get(key);
  if (!raw) return {};
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function writeDay(key, value) {
  if (_store) _store.set(key, JSON.stringify(value));
  else _mem.set(key, value);
}

/** Add `n` to one review counter for today (UTC). */
export function countReview(counter, n = 1, now = Date.now()) {
  if (!REVIEW_COUNTERS.includes(counter) || !(n > 0)) return;
  const key = dayKey(now);
  const day = readDay(key);
  day[counter] = (day[counter] || 0) + Math.floor(n);
  writeDay(key, day);
}

/** Totals over the last `windowDays` UTC days, today included. */
export function reviewTotals(windowDays = 7, now = Date.now()) {
  const out = { window_days: windowDays };
  for (const c of REVIEW_COUNTERS) out[c] = 0;
  for (let i = 0; i < windowDays; i++) {
    const day = readDay(dayKey(now - i * DAY));
    for (const c of REVIEW_COUNTERS) out[c] += day[c] || 0;
  }
  return out;
}

export function _resetReportStats() {
  _calls = [];
  _rate = null;
  _mem.clear();
  _store = null;
}
