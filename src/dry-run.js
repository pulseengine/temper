/**
 * Dry-run octokit: GETs go to GitHub (throttled, optionally cached on disk);
 * every other method is RECORDED and never sent.
 *
 * The plan is produced by running temper's real apply code
 * (`configureRepository`) against this object, so the recorded writes are by
 * construction exactly what an apply would send — there is no separate
 * "planner" to drift from the applier. Only `request` and `paginate` exist:
 * any other octokit surface (e.g. `octokit.repos.update`) is undefined here and
 * throws, so a write cannot slip past the recorder through a side door.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const READ_METHODS = new Set(['GET', 'HEAD']);

function methodOf(route, params) {
  const m = /^([A-Z]+)\s/.exec(route);
  return (m ? m[1] : params?.method || 'GET').toUpperCase();
}

function expand(route, params) {
  const url = route.replace(/^[A-Z]+\s+/, '');
  return url.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? encodeURIComponent(params[k]) : `{${k}}`));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stable(value[k]);
    return out;
  }
  return value;
}

/** Summarise a write's body for the plan; file contents are hashed, not printed. */
function summarise(params) {
  const body = {};
  for (const [k, v] of Object.entries(params || {})) {
    if (['owner', 'repo', 'headers', 'request'].includes(k)) continue;
    if (k === 'content' && typeof v === 'string') {
      body.content = `<${Buffer.from(v, 'base64').length} bytes sha256:${crypto
        .createHash('sha256')
        .update(Buffer.from(v, 'base64'))
        .digest('hex')
        .slice(0, 12)}>`;
    } else {
      body[k] = v;
    }
  }
  return body;
}

const RATE_LIMIT_RE = /secondary rate limit|rate limit exceeded|abuse detection/i;

/**
 * @param {object} real - a real Octokit (only its `request` is used, for reads)
 * @param {object} [opts]
 * @param {number} [opts.minIntervalMs=1000] - minimum gap between live GETs
 * @param {string|null} [opts.cacheDir] - persist GET responses (and errors) here
 * @param {Function} [opts.sleep] - injectable for tests
 */
export function createDryRunOctokit(real, { minIntervalMs = 1000, cacheDir = null, sleep, maxRetries = 3 } = {}) {
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const writes = [];
  const stats = { live: 0, cached: 0 };
  let last = 0;

  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });

  function cachePath(route, params) {
    const key = JSON.stringify([route, stable(params || {})]);
    return path.join(cacheDir, crypto.createHash('sha256').update(key).digest('hex') + '.json');
  }

  async function liveGet(route, params) {
    for (let attempt = 0; ; attempt++) {
      const gap = last + minIntervalMs - Date.now();
      if (gap > 0) await wait(gap);
      last = Date.now();
      stats.live++;
      try {
        const res = await real.request(route, params);
        return { status: res.status, data: res.data, headers: { link: res.headers?.link } };
      } catch (err) {
        const status = err.status || 0;
        if ((status === 403 || status === 429) && RATE_LIMIT_RE.test(err.message || '') && attempt < maxRetries) {
          await wait(60000 * (attempt + 1));
          continue;
        }
        return { error: { status, message: err.message } };
      }
    }
  }

  async function get(route, params) {
    let res;
    const file = cacheDir ? cachePath(route, params) : null;
    if (file && fs.existsSync(file)) {
      res = JSON.parse(fs.readFileSync(file, 'utf8'));
      stats.cached++;
    } else {
      res = await liveGet(route, params);
      if (file) fs.writeFileSync(file, JSON.stringify({ route, params, ...res }));
    }
    if (res.error) {
      const e = new Error(res.error.message);
      e.status = res.error.status;
      throw e;
    }
    return { status: res.status, data: res.data, headers: res.headers || {} };
  }

  async function request(route, params = {}) {
    const method = methodOf(route, params);
    if (READ_METHODS.has(method)) return get(route, params);
    writes.push({ method, url: expand(route, params), body: summarise(params) });
    // Plausible empty answers so callers that read a write's result keep going.
    return { status: 0, data: { dry_run: true, id: 0, number: 0, object: { sha: '0'.repeat(40) } }, headers: {} };
  }

  async function paginate(route, params = {}) {
    if (!READ_METHODS.has(methodOf(route, params))) {
      throw new Error(`dry-run: refusing to paginate a write (${route})`);
    }
    const perPage = params.per_page || 100;
    const all = [];
    for (let page = 1; page < 100; page++) {
      const res = await get(route, { ...params, per_page: perPage, page });
      const items = Array.isArray(res.data) ? res.data : res.data?.items || res.data?.workflow_runs || [];
      all.push(...items);
      if (items.length < perPage) break;
    }
    return all;
  }

  return {
    request,
    paginate,
    isDryRun: true,
    writes,
    stats,
    /** Take (and clear) the writes recorded since the last call. */
    drainWrites() {
      return writes.splice(0, writes.length);
    }
  };
}
