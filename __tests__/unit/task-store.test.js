import { initTaskStore } from '../../src/task-store.js';

describe('task-store', () => {
  let store;

  beforeEach(() => {
    store = initTaskStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('enqueue', () => {
    it('inserts a new task', () => {
      store.enqueue('test-type', 'key-1', { foo: 'bar' });
      expect(store.getPendingCount()).toBe(1);
    });

    it('deduplicates by key', () => {
      store.enqueue('test-type', 'key-1', { a: 1 });
      store.enqueue('test-type', 'key-1', { a: 2 });
      expect(store.getPendingCount()).toBe(1);
    });

    it('allows different keys', () => {
      store.enqueue('test-type', 'key-1', {});
      store.enqueue('test-type', 'key-2', {});
      expect(store.getPendingCount()).toBe(2);
    });

    it('respects delayMs option', () => {
      store.enqueue('test-type', 'delayed', {}, { delayMs: 999999 });
      // Task exists but is not yet claimable
      expect(store.getPendingCount()).toBe(1);
      const task = store.claimNextTask();
      expect(task).toBeNull();
    });

    it('respects maxAttempts option', () => {
      store.enqueue('test-type', 'key-1', {}, { maxAttempts: 5 });
      const task = store.claimNextTask();
      expect(task.max_attempts).toBe(5);
    });
  });

  describe('claimNextTask', () => {
    it('returns null when no tasks are pending', () => {
      expect(store.claimNextTask()).toBeNull();
    });

    it('claims the oldest pending task', () => {
      store.enqueue('type-a', 'k1', { order: 1 });
      store.enqueue('type-a', 'k2', { order: 2 });

      const task = store.claimNextTask();
      expect(task.payload).toEqual({ order: 1 });
      expect(task.status).toBe('in_progress');
    });

    it('does not return already claimed tasks', () => {
      store.enqueue('type-a', 'k1', {});
      store.claimNextTask();

      const second = store.claimNextTask();
      expect(second).toBeNull();
    });

    it('filters by task types when provided', () => {
      store.enqueue('type-a', 'k1', { v: 'a' });
      store.enqueue('type-b', 'k2', { v: 'b' });

      const task = store.claimNextTask(['type-b']);
      expect(task.type).toBe('type-b');
      expect(task.payload).toEqual({ v: 'b' });
    });

    it('parses JSON payload', () => {
      store.enqueue('t', 'k', { nested: { data: [1, 2] } });
      const task = store.claimNextTask();
      expect(task.payload).toEqual({ nested: { data: [1, 2] } });
    });
  });

  describe('completeTask', () => {
    it('marks task as completed', () => {
      store.enqueue('t', 'k', {});
      const task = store.claimNextTask();
      store.completeTask(task.id);

      const stats = store.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.pending).toBe(0);
      expect(stats.in_progress).toBe(0);
    });
  });

  describe('failTask', () => {
    it('returns task to pending with incremented attempts on first failure', () => {
      store.enqueue('t', 'k', {}, { maxAttempts: 3 });
      const task = store.claimNextTask();
      store.failTask(task.id, 'network error', { baseDelay: 0 });

      const stats = store.getStats();
      expect(stats.pending).toBe(1);
      expect(stats.failed).toBe(0);
    });

    it('marks as failed when max_attempts exceeded', () => {
      store.enqueue('t', 'k', {}, { maxAttempts: 1 });
      const task = store.claimNextTask();
      store.failTask(task.id, 'permanent error', { baseDelay: 0 });

      const stats = store.getStats();
      expect(stats.failed).toBe(1);
      expect(stats.pending).toBe(0);
    });

    it('stores last_error', () => {
      store.enqueue('t', 'k', {}, { maxAttempts: 2 });
      const task = store.claimNextTask();
      store.failTask(task.id, 'something broke', { baseDelay: 0 });

      // Re-claim the task
      const retried = store.claimNextTask();
      expect(retried.last_error).toBe('something broke');
      expect(retried.attempts).toBe(1);
    });

    it('applies exponential backoff delay', () => {
      store.enqueue('t', 'k', {}, { maxAttempts: 5 });
      const task = store.claimNextTask();
      store.failTask(task.id, 'err', { baseDelay: 60000 });

      // Task should not be claimable immediately (delay is at least 60s)
      const next = store.claimNextTask();
      expect(next).toBeNull();
    });
  });

  describe('getPendingCount', () => {
    it('returns 0 for empty store', () => {
      expect(store.getPendingCount()).toBe(0);
    });

    it('counts only pending tasks', () => {
      store.enqueue('t', 'k1', {});
      store.enqueue('t', 'k2', {});
      store.claimNextTask(); // k1 becomes in_progress

      expect(store.getPendingCount()).toBe(1);
    });
  });

  describe('getStats', () => {
    it('returns zero counts for empty store', () => {
      expect(store.getStats()).toEqual({
        pending: 0,
        in_progress: 0,
        completed: 0,
        failed: 0
      });
    });

    it('returns counts across all statuses', () => {
      store.enqueue('t', 'k1', {});
      store.enqueue('t', 'k2', {});
      store.enqueue('t', 'k3', {}, { maxAttempts: 1 });

      // k1 → completed
      const t1 = store.claimNextTask();
      store.completeTask(t1.id);

      // k2 → in_progress
      store.claimNextTask();

      // k3 → failed
      const t3 = store.claimNextTask();
      store.failTask(t3.id, 'err', { baseDelay: 0 });

      const stats = store.getStats();
      expect(stats.completed).toBe(1);
      expect(stats.in_progress).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.pending).toBe(0);
    });
  });
});
