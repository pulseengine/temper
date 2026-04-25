import { initKVStore } from '../../src/persistent-kv.js';

describe('persistent-kv', () => {
  let store;

  beforeEach(() => {
    store = initKVStore(':memory:', 'test', { ttlMs: 1000 });
  });

  afterEach(() => {
    store.close();
  });

  it('returns false for unknown key', () => {
    expect(store.has('nope')).toBe(false);
    expect(store.get('nope')).toBeUndefined();
  });

  it('stores and retrieves values', () => {
    store.set('a', 'hello');
    expect(store.has('a')).toBe(true);
    expect(store.get('a')).toBe('hello');
  });

  it('treats expired entries as absent', () => {
    store.set('b', 'x', { ttl: 1 });
    // Wait microscopically — expires_at is now+1ms; pause to ensure we crossed.
    return new Promise((resolve) => {
      setTimeout(() => {
        expect(store.has('b')).toBe(false);
        expect(store.get('b')).toBeUndefined();
        resolve();
      }, 5);
    });
  });

  it('upserts existing keys', () => {
    store.set('c', 'first');
    store.set('c', 'second');
    expect(store.get('c')).toBe('second');
  });

  it('sweep removes expired rows', () => {
    store.set('d', '1', { ttl: 1 });
    return new Promise((resolve) => {
      setTimeout(() => {
        const removed = store.sweep();
        expect(removed).toBe(1);
        resolve();
      }, 5);
    });
  });

  it('rejects invalid table names', () => {
    expect(() => initKVStore(':memory:', '1bad-name')).toThrow(/Invalid KV store name/);
    expect(() => initKVStore(':memory:', 'spaces inside')).toThrow(/Invalid KV store name/);
  });

  it('persists across separate stores on the same shared db (in-memory check)', () => {
    // Two stores with the same name share a table within their own connection;
    // separate names get separate tables on the same db.
    const a = initKVStore(':memory:', 'feature_a');
    const b = initKVStore(':memory:', 'feature_b');
    a.set('k', 'va');
    b.set('k', 'vb');
    expect(a.get('k')).toBe('va');
    expect(b.get('k')).toBe('vb');
    a.close();
    b.close();
  });
});
