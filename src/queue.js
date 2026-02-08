/**
 * Simple in-process async job queue.
 *
 * Jobs are processed sequentially (one at a time) to avoid GitHub API rate
 * limiting.  Each job is an async function.  If a job throws, the error is
 * logged and processing continues with the next job.
 */

import { getLogger } from './logger.js';

export class JobQueue {
  constructor() {
    /** @type {Array<{name: string, fn: () => Promise<*>}>} */
    this._pending = [];
    this._active = 0;
    this._completed = 0;
    this._failed = 0;
    this._processing = false;
  }

  /**
   * Add a job to the queue and kick off processing (if not already running).
   *
   * @param {() => Promise<*>} fn   Async function that performs the work.
   * @param {string}           [name='unnamed'] Human-readable label for logging.
   */
  enqueue(fn, name = 'unnamed') {
    this._pending.push({ fn, name });
    this._processNext();
  }

  /**
   * Return current queue statistics.
   * @returns {{pending: number, active: number, completed: number, failed: number}}
   */
  stats() {
    return {
      pending: this._pending.length,
      active: this._active,
      completed: this._completed,
      failed: this._failed
    };
  }

  /**
   * Internal: process the next job in the queue (if any).  Ensures only one
   * job runs at a time.
   */
  async _processNext() {
    if (this._processing) {
      return;
    }
    if (this._pending.length === 0) {
      return;
    }

    this._processing = true;

    while (this._pending.length > 0) {
      const job = this._pending.shift();
      this._active = 1;

      try {
        await job.fn();
        this._completed += 1;
      } catch (error) {
        this._failed += 1;
        getLogger().error(`Queue job "${job.name}" failed:`, error.message || error);
      } finally {
        this._active = 0;
      }
    }

    this._processing = false;
  }
}

// Singleton instance used by the app.
export const defaultQueue = new JobQueue();
