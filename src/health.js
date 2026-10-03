/**
 * Liveness probe for /health (Bug #8).
 *
 * The previous /health endpoint returned 200 unconditionally — which means
 * PM2's restart-on-failed-healthcheck and any external uptime monitor were
 * both blind to a hung scheduler, a locked SQLite DB, or a full data disk.
 *
 * The checks here are *liveness* signals (am I able to do my job RIGHT NOW),
 * not readiness (have I finished initialising). All checks are best-effort:
 * if a check itself throws unexpectedly, that check is reported as
 * `'error'` and the overall verdict is `degraded` — we'd rather report
 * something slightly wrong than mask a real outage.
 *
 *   ok:        every check passed
 *   degraded:  a check is missing or threw; not actionable but worth
 *              flagging in dashboards. /health returns 200.
 *   unhealthy: a check has FAILED in a way that means the bot can't do
 *              its job (DB ping throws, scheduler hung, disk full).
 *              /health returns 503 so PM2 / uptime monitors restart us.
 */

import fs from 'node:fs';

const MIN_FREE_DISK_BYTES = 100 * 1024 * 1024; // 100 MB — below this we
// risk losing the next sweep / commit. Threshold low because Netcup VM
// only has ~30 GB total.

const SCHEDULER_STALE_FACTOR = 2; // a tick should land within 2× the
// configured interval — beyond that, the scheduler is hung.

/**
 * Synchronously evaluate liveness. Cheap (millisecond-range) by design —
 * /health is hit by PM2 every few seconds.
 *
 * @param {object} probes
 * @param {object} [probes.scheduler] - { isRunning(), getLastTickAt(), getIntervalMs() }
 * @param {object} [probes.kv] - { ping() } — typically the dedup KV store
 * @param {string} [probes.dataDir] - filesystem path checked for free space
 * @returns {{
 *   ok: boolean,
 *   status: 'healthy'|'degraded'|'unhealthy',
 *   checks: Record<string, { ok: boolean, status: 'ok'|'warn'|'fail'|'error', detail?: any }>
 * }}
 */
export function evaluateHealth(probes = {}) {
  const checks = {};
  let unhealthy = false;
  let degraded = false;

  // 1. Scheduler tick freshness ---------------------------------------------
  if (probes.scheduler) {
    try {
      const isRunning = probes.scheduler.isRunning();
      const lastTickAt = probes.scheduler.getLastTickAt?.() ?? null;
      const intervalMs = probes.scheduler.getIntervalMs?.() ?? 5 * 60 * 1000;
      const staleAfter = intervalMs * SCHEDULER_STALE_FACTOR;

      if (!isRunning) {
        // Scheduler was never started (or has been stopped). Not necessarily
        // an outage — `start()` may not have been called yet (early in
        // probot bootstrap). Don't flunk /health for it.
        checks.scheduler = { ok: true, status: 'ok', detail: { running: false } };
      } else if (lastTickAt === null) {
        // Started but no tick has completed yet — first tick fires
        // immediately on start(), so we expect a value within milliseconds.
        // Don't fail here either; report as warn so dashboards see it.
        checks.scheduler = { ok: true, status: 'warn', detail: { running: true, lastTickAt: null } };
        degraded = true;
      } else {
        const ageMs = Date.now() - lastTickAt;
        const stale = ageMs > staleAfter;
        checks.scheduler = {
          ok: !stale,
          status: stale ? 'fail' : 'ok',
          detail: { running: true, ageMs, staleAfterMs: staleAfter }
        };
        if (stale) unhealthy = true;
      }
    } catch (err) {
      checks.scheduler = { ok: false, status: 'error', detail: err.message };
      degraded = true;
    }
  }

  // 2. SQLite ping ---------------------------------------------------------
  if (probes.kv && typeof probes.kv.ping === 'function') {
    try {
      probes.kv.ping();
      checks.kv = { ok: true, status: 'ok' };
    } catch (err) {
      checks.kv = { ok: false, status: 'fail', detail: err.message };
      unhealthy = true;
    }
  }

  // 3. Free disk on the data directory -------------------------------------
  if (probes.dataDir && typeof fs.statfsSync === 'function') {
    try {
      const stat = fs.statfsSync(probes.dataDir);
      const freeBytes = Number(stat.bavail) * Number(stat.bsize);
      const ok = freeBytes >= MIN_FREE_DISK_BYTES;
      checks.disk = {
        ok,
        status: ok ? 'ok' : 'fail',
        detail: { freeBytes, thresholdBytes: MIN_FREE_DISK_BYTES }
      };
      if (!ok) unhealthy = true;
    } catch (err) {
      checks.disk = { ok: false, status: 'error', detail: err.message };
      degraded = true;
    }
  }

  let status;
  if (unhealthy) status = 'unhealthy';
  else if (degraded) status = 'degraded';
  else status = 'healthy';

  return { ok: !unhealthy, status, checks };
}
