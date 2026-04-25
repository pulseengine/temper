/**
 * Webhook idempotency guard.
 *
 * Backed by SQLite when `setIdempotencyStore` has been called; falls back to an
 * in-memory `Map` otherwise (tests, dev). Either backend dedupes GitHub webhook
 * delivery IDs so re-delivered webhooks are silently skipped.
 *
 * Entries older than 1 hour are cleaned up automatically every 10 minutes to
 * prevent unbounded growth in either backend.
 */

const ENTRY_TTL_MS = 60 * 60 * 1000; // 1 hour
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/** @type {Map<string, number>} deliveryId -> timestamp (in-memory fallback) */
const memStore = new Map();

/** @type {{has, set, sweep}|null} optional SQLite-backed KV store */
let persistStore = null;

let cleanupTimer = null;

/**
 * Swap in a persistent KV store (SQLite). Calling with `null` reverts to
 * in-memory behaviour. The caller owns the lifecycle of the store.
 */
export function setIdempotencyStore(store) {
  persistStore = store;
}

export function isProcessed(deliveryId) {
  if (persistStore) return persistStore.has(deliveryId);
  const ts = memStore.get(deliveryId);
  if (ts === undefined) return false;
  if (ts < Date.now() - ENTRY_TTL_MS) {
    memStore.delete(deliveryId);
    return false;
  }
  return true;
}

export function markProcessed(deliveryId) {
  if (persistStore) {
    persistStore.set(deliveryId, '1', { ttl: ENTRY_TTL_MS });
    return;
  }
  memStore.set(deliveryId, Date.now());
}

export function cleanup() {
  if (persistStore) {
    persistStore.sweep();
    return;
  }
  const cutoff = Date.now() - ENTRY_TTL_MS;
  for (const [id, ts] of memStore) {
    if (ts < cutoff) memStore.delete(id);
  }
}

export function startAutoCleanup() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  if (cleanupTimer.unref) cleanupTimer.unref();
}

export function stopAutoCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

startAutoCleanup();

/** Exposed for tests only — returns the in-memory Map. */
export function _getStore() {
  return memStore;
}
