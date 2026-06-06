/**
 * SQLite-backed key/value store with TTL.
 *
 * Used to persist idempotency keys (webhook delivery IDs) and AI review rate
 * limits across process restarts. The previous in-memory Map-based stores
 * lost both on every PM2 reload — webhooks were re-processed and PRs were
 * re-reviewed, both of which violate at-most-once semantics.
 */

import Database from 'better-sqlite3';

// Bug #5: callers (app.js) use the same SQLite file for two logical
// stores ('webhook_dedup' and 'ai_rate_limits' both live in dedup.db).
// Opening two `Database` connections against the same file works for
// reads under WAL but produces SQLITE_BUSY on concurrent writes — and
// `markProcessed` + `recordReview` race regularly. Cache by absolute
// dbPath so the second call against the same file shares the same
// underlying connection. `:memory:` stays per-call: each `:memory:`
// open is its own DB by SQLite design, so caching it would produce
// surprising cross-store sharing in tests.
const _connections = new Map(); // dbPath → { db, refs }

function acquireConnection(dbPath) {
  if (dbPath === ':memory:') {
    const db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    return { db, release: () => db.close() };
  }
  let entry = _connections.get(dbPath);
  if (!entry) {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    entry = { db, refs: 0 };
    _connections.set(dbPath, entry);
  }
  entry.refs += 1;
  return {
    db: entry.db,
    release: () => {
      entry.refs -= 1;
      if (entry.refs <= 0) {
        _connections.delete(dbPath);
        entry.db.close();
      }
    }
  };
}

/**
 * Initialise (or attach to) a SQLite-backed KV table. Tables are namespaced
 * by `name` so multiple stores can share one database file. Multiple stores
 * against the same file path share one underlying SQLite connection (see
 * Bug #5 — concurrent writes from two connections produce SQLITE_BUSY).
 *
 * @param {string} dbPath - SQLite file path (or ':memory:' for ephemeral)
 * @param {string} name - logical table name (alphanumeric / underscores)
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] - default TTL applied when not provided per-write.
 *                                 Entries older than ttl are deleted on read.
 * @returns {{has, get, set, sweep, close, _db}}
 */
export function initKVStore(dbPath, name, opts = {}) {
  if (!/^[a-z][a-z0-9_]*$/i.test(name)) {
    throw new Error(`Invalid KV store name: ${name}`);
  }
  const ttlMs = opts.ttlMs;

  const { db, release } = acquireConnection(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_${name} (
      key       TEXT PRIMARY KEY,
      value     TEXT,
      expires_at INTEGER
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kv_${name}_expires ON kv_${name}(expires_at)`);

  const stmts = {
    get: db.prepare(`SELECT value, expires_at FROM kv_${name} WHERE key = ?`),
    upsert: db.prepare(`
      INSERT INTO kv_${name} (key, value, expires_at)
      VALUES (@key, @value, @expires_at)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        expires_at = excluded.expires_at
    `),
    sweep: db.prepare(`DELETE FROM kv_${name} WHERE expires_at IS NOT NULL AND expires_at < ?`)
  };

  function has(key) {
    const row = stmts.get.get(key);
    if (!row) return false;
    if (row.expires_at && row.expires_at < Date.now()) return false;
    return true;
  }

  function get(key) {
    const row = stmts.get.get(key);
    if (!row) return undefined;
    if (row.expires_at && row.expires_at < Date.now()) return undefined;
    return row.value;
  }

  function set(key, value = '', { ttl } = {}) {
    const effectiveTtl = ttl ?? ttlMs;
    const expires_at = effectiveTtl ? Date.now() + effectiveTtl : null;
    stmts.upsert.run({ key, value: String(value), expires_at });
  }

  function sweep() {
    return stmts.sweep.run(Date.now()).changes;
  }

  function close() {
    release();
  }

  return { has, get, set, sweep, close, _db: db };
}
