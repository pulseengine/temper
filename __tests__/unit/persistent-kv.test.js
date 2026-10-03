import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
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

  // Bug #5: two file-backed stores against the same dbPath must share one
  // underlying connection so concurrent writes don't trip SQLITE_BUSY.
  describe('shared file-backed connection (Bug #5)', () => {
    let tmpDir;
    let dbPath;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'temper-kv-test-'));
      dbPath = path.join(tmpDir, 'shared.db');
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('shares one underlying Database across two stores on the same path', () => {
      const a = initKVStore(dbPath, 'dedup');
      const b = initKVStore(dbPath, 'rate_limits');
      // ._db is the underlying better-sqlite3 Database; identity check is the
      // tightest assertion that a single connection backs both stores.
      expect(a._db).toBe(b._db);
      a.close();
      b.close();
    });

    it('keeps the connection alive while at least one store still uses it', () => {
      const a = initKVStore(dbPath, 'dedup');
      const b = initKVStore(dbPath, 'rate_limits');
      a.set('hello', 'world');
      a.close();
      // a is closed but b still holds the connection — writes must succeed.
      expect(() => b.set('still', 'ok')).not.toThrow();
      expect(b.get('still')).toBe('ok');
      b.close();
    });

    it('closes the connection when the last store releases it', () => {
      const a = initKVStore(dbPath, 'dedup');
      const dbRef = a._db;
      a.close();
      // The Database is closed; using a closed handle throws.
      expect(() => dbRef.prepare('SELECT 1').get()).toThrow();
    });

    it('reopens cleanly after all stores have closed', () => {
      const a = initKVStore(dbPath, 'dedup');
      a.set('x', '1');
      a.close();

      const reopened = initKVStore(dbPath, 'dedup');
      expect(reopened.get('x')).toBe('1');
      reopened.close();
    });
  });
});
