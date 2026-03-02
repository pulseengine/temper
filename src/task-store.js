/**
 * Persistent task queue backed by SQLite (better-sqlite3).
 * Provides enqueue/claim/complete/fail semantics with deduplication.
 */

import Database from 'better-sqlite3';

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS tasks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    type        TEXT NOT NULL,
    key         TEXT UNIQUE,
    payload     TEXT,
    status      TEXT NOT NULL DEFAULT 'pending',
    attempts    INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    next_run_at INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    last_error  TEXT
  )
`;

const INDEX_SQL = `
  CREATE INDEX IF NOT EXISTS idx_tasks_status_next_run
    ON tasks (status, next_run_at)
`;

function initTaskStore(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(CREATE_TABLE_SQL);
  db.exec(INDEX_SQL);

  const stmts = {
    enqueue: db.prepare(`
      INSERT OR IGNORE INTO tasks (type, key, payload, status, attempts, max_attempts, next_run_at, created_at, updated_at)
      VALUES (@type, @key, @payload, 'pending', 0, @max_attempts, @next_run_at, @now, @now)
    `),

    claimNext: db.prepare(`
      UPDATE tasks
      SET status = 'in_progress', updated_at = @now
      WHERE id = (
        SELECT id FROM tasks
        WHERE status = 'pending' AND next_run_at <= @now
        ORDER BY next_run_at ASC, id ASC
        LIMIT 1
      )
      RETURNING *
    `),

    claimNextByTypes: db.prepare(`
      UPDATE tasks
      SET status = 'in_progress', updated_at = @now
      WHERE id = (
        SELECT id FROM tasks
        WHERE status = 'pending' AND next_run_at <= @now AND type IN (SELECT value FROM json_each(@types))
        ORDER BY next_run_at ASC, id ASC
        LIMIT 1
      )
      RETURNING *
    `),

    complete: db.prepare(`
      UPDATE tasks SET status = 'completed', updated_at = @now WHERE id = @id
    `),

    fail: db.prepare(`
      UPDATE tasks
      SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
          attempts = attempts + 1,
          last_error = @error,
          next_run_at = @next_run_at,
          updated_at = @now
      WHERE id = @id
    `),

    pendingCount: db.prepare(`
      SELECT COUNT(*) as count FROM tasks WHERE status = 'pending'
    `),

    stats: db.prepare(`
      SELECT status, COUNT(*) as count FROM tasks GROUP BY status
    `)
  };

  return {
    /**
     * Enqueue a task. Deduplicates by key (INSERT OR IGNORE).
     * @param {string} type
     * @param {string} key - dedup key, e.g. 'generate-dependabot:owner/repo'
     * @param {object} payload
     * @param {object} [opts]
     * @param {number} [opts.maxAttempts=3]
     * @param {number} [opts.delayMs=0]
     */
    enqueue(type, key, payload, opts = {}) {
      const { maxAttempts = 3, delayMs = 0 } = opts;
      const now = Date.now();
      return stmts.enqueue.run({
        type,
        key,
        payload: JSON.stringify(payload),
        max_attempts: maxAttempts,
        next_run_at: now + delayMs,
        now
      });
    },

    /**
     * Atomically claim the next pending task due for execution.
     * @param {string[]} [types] - optional list of task types to filter
     * @returns {object|null} the claimed task row (with parsed payload), or null
     */
    claimNextTask(types) {
      const now = Date.now();
      let row;
      if (types && types.length > 0) {
        row = stmts.claimNextByTypes.get({ now, types: JSON.stringify(types) });
      } else {
        row = stmts.claimNext.get({ now });
      }
      if (!row) return null;
      try { row.payload = JSON.parse(row.payload); } catch { /* keep as string */ }
      return row;
    },

    /**
     * Mark a task as completed.
     */
    completeTask(id) {
      stmts.complete.run({ id, now: Date.now() });
    },

    /**
     * Mark a task as failed. Increments attempts and applies exponential backoff.
     * If max_attempts is exceeded, marks as permanently failed.
     * @param {number} id
     * @param {string} error
     * @param {object} [opts]
     * @param {number} [opts.baseDelay=60000] - base backoff delay in ms
     * @param {number} [opts.maxDelay=3600000] - max backoff delay (1 hour)
     */
    failTask(id, error, opts = {}) {
      const { baseDelay = 60000, maxDelay = 3600000 } = opts;
      const now = Date.now();
      // Fetch current attempts to calculate backoff
      const task = db.prepare('SELECT attempts FROM tasks WHERE id = ?').get(id);
      const attempts = task ? task.attempts : 0;
      const delay = Math.min(baseDelay * Math.pow(2, attempts), maxDelay);
      stmts.fail.run({ id, error, next_run_at: now + delay, now });
    },

    /**
     * Get count of pending tasks.
     */
    getPendingCount() {
      return stmts.pendingCount.get().count;
    },

    /**
     * Get task counts by status.
     * @returns {{pending: number, in_progress: number, completed: number, failed: number}}
     */
    getStats() {
      const rows = stmts.stats.all();
      const stats = { pending: 0, in_progress: 0, completed: 0, failed: 0 };
      for (const row of rows) {
        stats[row.status] = row.count;
      }
      return stats;
    },

    /** Close the database connection. */
    close() {
      db.close();
    },

    /** Expose db for testing purposes. */
    _db: db
  };
}

export { initTaskStore };
