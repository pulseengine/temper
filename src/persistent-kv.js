/**
 * SQLite-backed key/value store with TTL.
 *
 * Used to persist idempotency keys (webhook delivery IDs) and AI review rate
 * limits across process restarts. The previous in-memory Map-based stores
 * lost both on every PM2 reload — webhooks were re-processed and PRs were
 * re-reviewed, both of which violate at-most-once semantics.
 */

import Database from 'better-sqlite3';

/**
 * Initialise (or attach to) a SQLite-backed KV table. Tables are namespaced
 * by `name` so multiple stores can share one database file.
 *
 * @param {string} dbPath - SQLite file path
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

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
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
    db.close();
  }

  // Bug #8: /health uses ping() as a SQLite liveness probe. Throws if
  // the connection is dead, the file is locked beyond timeout, or disk
  // I/O is jammed. SELECT 1 doesn't touch any table — minimum latency.
  function ping() {
    db.prepare('SELECT 1 AS ok').get();
  }

  return { has, get, set, sweep, close, ping, _db: db };
}
