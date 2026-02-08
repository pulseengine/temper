import { isProcessed, markProcessed, cleanup, stopAutoCleanup, _getStore } from '../../src/idempotency.js';

describe('idempotency', () => {
  afterEach(() => {
    _getStore().clear();
  });

  afterAll(() => {
    stopAutoCleanup();
  });

  it('returns false for unknown delivery IDs', () => {
    expect(isProcessed('abc-123')).toBe(false);
  });

  it('returns true after marking as processed', () => {
    markProcessed('abc-123');
    expect(isProcessed('abc-123')).toBe(true);
  });

  it('tracks multiple delivery IDs independently', () => {
    markProcessed('id-1');
    markProcessed('id-2');
    expect(isProcessed('id-1')).toBe(true);
    expect(isProcessed('id-2')).toBe(true);
    expect(isProcessed('id-3')).toBe(false);
  });

  it('cleanup removes old entries', () => {
    const store = _getStore();
    store.set('old-id', Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    store.set('new-id', Date.now());
    cleanup();
    expect(isProcessed('old-id')).toBe(false);
    expect(isProcessed('new-id')).toBe(true);
  });

  it('cleanup keeps recent entries', () => {
    markProcessed('recent');
    cleanup();
    expect(isProcessed('recent')).toBe(true);
  });
});
