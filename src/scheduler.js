/**
 * Cron-like scheduler that processes tasks from the task store.
 * Checks GitHub API rate limits before each tick.
 */

import { getLogger } from './logger.js';

/**
 * @param {object} store - task store with claimNextTask / completeTask / failTask
 * @param {object|Function} octokitOrFactory - either an octokit instance, or
 *   an async () => octokit factory called once per tick. Probot installation
 *   tokens expire after 1 hour; use the factory form in production so each
 *   tick gets a fresh, installation-scoped client.
 * @param {object} [options]
 */
function createScheduler(store, octokitOrFactory, options = {}) {
  const {
    intervalMs = 5 * 60 * 1000,
    maxTasksPerTick = 5,
    rateLimitThreshold = 100
  } = options;

  const handlers = new Map();
  let timer = null;
  let running = false;

  async function getOctokit() {
    if (typeof octokitOrFactory === 'function') {
      return await octokitOrFactory();
    }
    return octokitOrFactory;
  }

  async function checkRateLimit(octokit) {
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
      let octokit;
      try {
        octokit = await getOctokit();
      } catch (err) {
        getLogger().warn({ err: err.message }, 'Scheduler: could not obtain octokit, skipping tick');
        return;
      }

      const rateLimitOk = await checkRateLimit(octokit);
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
