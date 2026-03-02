/**
 * Cron-like scheduler that processes tasks from the task store.
 * Checks GitHub API rate limits before each tick.
 */

import { getLogger } from './logger.js';

function createScheduler(store, octokit, options = {}) {
  const {
    intervalMs = 5 * 60 * 1000,
    maxTasksPerTick = 5,
    rateLimitThreshold = 100
  } = options;

  const handlers = new Map();
  let timer = null;
  let running = false;

  async function checkRateLimit() {
    try {
      const response = await octokit.request('GET /rate_limit');
      const { remaining } = response.data.resources.core;
      if (remaining < rateLimitThreshold) {
        getLogger().warn(
          { remaining, threshold: rateLimitThreshold },
          'Scheduler: rate limit low, skipping tick'
        );
        return false;
      }
      return true;
    } catch (error) {
      getLogger().warn({ err: error.message }, 'Scheduler: could not check rate limit, skipping tick');
      return false;
    }
  }

  async function tick() {
    if (running) return;
    running = true;

    try {
      const rateLimitOk = await checkRateLimit();
      if (!rateLimitOk) return;

      let processed = 0;
      while (processed < maxTasksPerTick) {
        const task = store.claimNextTask();
        if (!task) break;

        const handler = handlers.get(task.type);
        if (!handler) {
          getLogger().warn({ type: task.type }, 'Scheduler: no handler registered for task type');
          store.failTask(task.id, `No handler registered for type: ${task.type}`);
          processed++;
          continue;
        }

        try {
          await handler(task.payload, { octokit, logger: getLogger(), store });
          store.completeTask(task.id);
          getLogger().info({ taskId: task.id, type: task.type }, 'Scheduler: task completed');
        } catch (error) {
          store.failTask(task.id, error.message);
          getLogger().error(
            { taskId: task.id, type: task.type, err: error.message },
            'Scheduler: task failed'
          );
        }

        processed++;
      }

      if (processed > 0) {
        getLogger().info({ processed }, 'Scheduler: tick complete');
      }
    } finally {
      running = false;
    }
  }

  return {
    registerHandler(type, fn) {
      handlers.set(type, fn);
    },

    start() {
      if (timer) return;
      getLogger().info({ intervalMs, maxTasksPerTick, rateLimitThreshold }, 'Scheduler started');
      // Run first tick immediately, then on interval
      tick();
      timer = setInterval(tick, intervalMs);
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
        getLogger().info('Scheduler stopped');
      }
    },

    /** Run a single tick manually (for testing / commands). */
    tick,

    /** Check if the scheduler is running. */
    isRunning() {
      return timer !== null;
    }
  };
}

export { createScheduler };
