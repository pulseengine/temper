/**
 * Retry with exponential back-off and jitter.
 *
 * Only retries on *transient* errors:
 *   - HTTP 5xx server errors
 *   - HTTP 429 rate-limit responses
 *   - Network / system errors (no HTTP status at all)
 *
 * 4xx client errors (except 429) are considered permanent and are thrown
 * immediately without retry.
 */

import { getLogger } from './logger.js';

const DEFAULT_OPTIONS = {
  maxRetries: 3,
  baseDelay: 1000,    // ms
  maxDelay: 30000     // ms
};

/**
 * Decide whether an error is transient and worth retrying.
 * @param {Error} error
 * @returns {boolean}
 */
function isTransientError(error) {
  const status = error.status || error.statusCode || (error.response && error.response.status);

  // No HTTP status at all -> network / system error -> transient
  if (status === undefined || status === null) {
    return true;
  }

  // 429 Too Many Requests -> rate limited -> transient
  if (status === 429) {
    return true;
  }

  // 5xx -> server error -> transient
  if (status >= 500 && status < 600) {
    return true;
  }

  // Everything else (4xx except 429) -> permanent
  return false;
}

/**
 * Calculate delay with exponential back-off and random jitter.
 * @param {number} attempt   0-based attempt index
 * @param {number} baseDelay
 * @param {number} maxDelay
 * @returns {number} delay in ms
 */
function calculateDelay(attempt, baseDelay, maxDelay) {
  const exponential = baseDelay * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelay;
  return Math.min(exponential + jitter, maxDelay);
}

/**
 * Wrap an async function with retry logic.
 *
 * @param {() => Promise<*>} fn        The async function to execute.
 * @param {object}          [options]  Override default retry settings.
 * @param {number}          [options.maxRetries=3]
 * @param {number}          [options.baseDelay=1000]
 * @param {number}          [options.maxDelay=30000]
 * @returns {Promise<*>} The result of a successful call to fn.
 */
async function withRetry(fn, options = {}) {
  const { maxRetries, baseDelay, maxDelay } = { ...DEFAULT_OPTIONS, ...options };

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // If this is the last attempt or the error is not transient, throw now.
      if (attempt >= maxRetries || !isTransientError(error)) {
        throw error;
      }

      const delay = calculateDelay(attempt, baseDelay, maxDelay);
      getLogger().info(
        `Retry attempt ${attempt + 1}/${maxRetries} after ${Math.round(delay)}ms — ` +
        `error: ${error.message || error}`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Should be unreachable, but just in case:
  throw lastError;
}

export {
  withRetry,
  isTransientError,
  calculateDelay,
  DEFAULT_OPTIONS
};
