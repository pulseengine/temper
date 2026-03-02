jest.mock('../../src/logger.js', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { getLogger: jest.fn(() => mockLogger) };
});

import { createScheduler } from '../../src/scheduler.js';
import { initTaskStore } from '../../src/task-store.js';
import { getLogger } from '../../src/logger.js';

describe('scheduler', () => {
  let store;
  let mockOctokit;
  let scheduler;

  beforeEach(() => {
    store = initTaskStore(':memory:');
    mockOctokit = {
      request: jest.fn().mockResolvedValue({
        data: { resources: { core: { remaining: 5000 } } }
      })
    };
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (scheduler) scheduler.stop();
    store.close();
  });

  describe('tick processing', () => {
    it('processes a pending task', async () => {
      const handler = jest.fn();
      scheduler = createScheduler(store, mockOctokit, { intervalMs: 999999 });
      scheduler.registerHandler('test', handler);

      store.enqueue('test', 'k1', { foo: 'bar' });

      await scheduler.tick();

      expect(handler).toHaveBeenCalledWith(
        { foo: 'bar' },
        expect.objectContaining({ octokit: mockOctokit })
      );
      expect(store.getStats().completed).toBe(1);
    });

    it('processes multiple tasks up to maxTasksPerTick', async () => {
      const handler = jest.fn();
      scheduler = createScheduler(store, mockOctokit, { maxTasksPerTick: 2, intervalMs: 999999 });
      scheduler.registerHandler('test', handler);

      store.enqueue('test', 'k1', {});
      store.enqueue('test', 'k2', {});
      store.enqueue('test', 'k3', {});

      await scheduler.tick();

      expect(handler).toHaveBeenCalledTimes(2);
      expect(store.getStats().completed).toBe(2);
      expect(store.getStats().pending).toBe(1);
    });

    it('fails task when handler throws', async () => {
      const handler = jest.fn().mockRejectedValue(new Error('handler error'));
      scheduler = createScheduler(store, mockOctokit, { intervalMs: 999999 });
      scheduler.registerHandler('test', handler);

      store.enqueue('test', 'k1', {}, { maxAttempts: 2 });

      await scheduler.tick();

      const stats = store.getStats();
      // Failed once but max_attempts=2, so back to pending
      expect(stats.pending).toBe(1);
      expect(stats.completed).toBe(0);
    });

    it('fails task when no handler is registered', async () => {
      scheduler = createScheduler(store, mockOctokit, { intervalMs: 999999 });

      store.enqueue('unknown-type', 'k1', {});

      await scheduler.tick();

      expect(getLogger().warn).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'unknown-type' }),
        expect.stringContaining('no handler registered')
      );
    });

    it('does nothing when no tasks pending', async () => {
      const handler = jest.fn();
      scheduler = createScheduler(store, mockOctokit, { intervalMs: 999999 });
      scheduler.registerHandler('test', handler);

      await scheduler.tick();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('rate limit checking', () => {
    it('skips tick when rate limit is below threshold', async () => {
      mockOctokit.request.mockResolvedValue({
        data: { resources: { core: { remaining: 50 } } }
      });

      const handler = jest.fn();
      scheduler = createScheduler(store, mockOctokit, { rateLimitThreshold: 100, intervalMs: 999999 });
      scheduler.registerHandler('test', handler);

      store.enqueue('test', 'k1', {});

      await scheduler.tick();

      expect(handler).not.toHaveBeenCalled();
      expect(getLogger().warn).toHaveBeenCalledWith(
        expect.objectContaining({ remaining: 50, threshold: 100 }),
        expect.stringContaining('rate limit low')
      );
    });

    it('proceeds when rate limit is above threshold', async () => {
      mockOctokit.request.mockResolvedValue({
        data: { resources: { core: { remaining: 500 } } }
      });

      const handler = jest.fn();
      scheduler = createScheduler(store, mockOctokit, { rateLimitThreshold: 100, intervalMs: 999999 });
      scheduler.registerHandler('test', handler);

      store.enqueue('test', 'k1', {});

      await scheduler.tick();

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('skips tick when rate limit check fails', async () => {
      mockOctokit.request.mockRejectedValue(new Error('network error'));

      const handler = jest.fn();
      scheduler = createScheduler(store, mockOctokit, { intervalMs: 999999 });
      scheduler.registerHandler('test', handler);

      store.enqueue('test', 'k1', {});

      await scheduler.tick();

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('start/stop', () => {
    it('starts and stops the interval', () => {
      scheduler = createScheduler(store, mockOctokit, { intervalMs: 60000 });

      expect(scheduler.isRunning()).toBe(false);
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });

    it('start is idempotent', () => {
      scheduler = createScheduler(store, mockOctokit, { intervalMs: 60000 });
      scheduler.start();
      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);
      scheduler.stop();
    });

    it('stop is idempotent', () => {
      scheduler = createScheduler(store, mockOctokit, { intervalMs: 60000 });
      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    });
  });

  describe('registerHandler', () => {
    it('registers and dispatches to the correct handler', async () => {
      const handlerA = jest.fn();
      const handlerB = jest.fn();
      scheduler = createScheduler(store, mockOctokit, { intervalMs: 999999 });
      scheduler.registerHandler('type-a', handlerA);
      scheduler.registerHandler('type-b', handlerB);

      store.enqueue('type-b', 'k1', { x: 1 });

      await scheduler.tick();

      expect(handlerA).not.toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalledWith({ x: 1 }, expect.anything());
    });
  });
});
