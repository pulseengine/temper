/**
 * Webhook idempotency guard.
 *
 * Keeps an in-memory record of GitHub webhook delivery IDs that have already
 * been processed so that re-delivered webhooks are silently skipped.
 *
 * Entries older than 1 hour are cleaned up automatically every 10 minutes to
 * prevent unbounded memory growth.
 */

const ENTRY_TTL_MS = 60 * 60 * 1000;          // 1 hour
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes

/** @type {Map<string, number>} deliveryId -> timestamp */
const store = new Map();

let cleanupTimer = null;

/**
 * Returns true if the given delivery ID has already been processed.
 * @param {string} deliveryId
 * @returns {boolean}
 */
function isProcessed(deliveryId) {
  return store.has(deliveryId);
}

/**
 * Records a delivery ID as processed, with the current timestamp.
 * @param {string} deliveryId
 */
function markProcessed(deliveryId) {
  store.set(deliveryId, Date.now());
}

/**
 * Removes entries older than ENTRY_TTL_MS.
 */
function cleanup() {
  const cutoff = Date.now() - ENTRY_TTL_MS;
  for (const [id, ts] of store) {
    if (ts < cutoff) {
      store.delete(id);
    }
  }
}

/**
 * Start the automatic cleanup interval.  Safe to call more than once (will
 * not create duplicate timers).
 */
function startAutoCleanup() {
  if (cleanupTimer) {
    return;
  }
  cleanupTimer = setInterval(cleanup, CLEANUP_INTERVAL_MS);
  // Allow the process to exit even if the timer is still active.
  if (cleanupTimer.unref) {
    cleanupTimer.unref();
  }
}

/**
 * Stop the automatic cleanup interval (useful in tests).
 */
function stopAutoCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// Start auto-cleanup on module load.
startAutoCleanup();

/**
 * Exposed for testing only -- returns the internal Map so tests can inspect
 * state directly.
 * @returns {Map<string, number>}
 */
function _getStore() {
  return store;
}

export {
  isProcessed,
  markProcessed,
  cleanup,
  startAutoCleanup,
  stopAutoCleanup,
  _getStore
};
