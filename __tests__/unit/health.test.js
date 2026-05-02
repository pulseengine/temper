import { evaluateHealth } from '../../src/health.js';

describe('evaluateHealth', () => {
  it('reports healthy when no probes are provided', () => {
    const result = evaluateHealth({});
    expect(result).toEqual({ ok: true, status: 'healthy', checks: {} });
  });

  describe('scheduler probe', () => {
    function fakeScheduler({ running, lastTickAt, intervalMs = 60_000 } = {}) {
      return {
        isRunning: () => running,
        getLastTickAt: () => lastTickAt,
        getIntervalMs: () => intervalMs
      };
    }

    it('passes when not running (treated as not-yet-started)', () => {
      const result = evaluateHealth({ scheduler: fakeScheduler({ running: false }) });
      expect(result.status).toBe('healthy');
      expect(result.checks.scheduler.ok).toBe(true);
    });

    it('reports degraded when running but no tick has completed yet', () => {
      const result = evaluateHealth({
        scheduler: fakeScheduler({ running: true, lastTickAt: null })
      });
      expect(result.status).toBe('degraded');
      expect(result.checks.scheduler.status).toBe('warn');
      expect(result.ok).toBe(true);
    });

    it('passes when last tick is within 2× the configured interval', () => {
      const ageMs = 30_000; // less than 2 * 60_000
      const result = evaluateHealth({
        scheduler: fakeScheduler({ running: true, lastTickAt: Date.now() - ageMs })
      });
      expect(result.status).toBe('healthy');
      expect(result.checks.scheduler.ok).toBe(true);
      expect(result.checks.scheduler.detail.ageMs).toBeGreaterThanOrEqual(ageMs);
    });

    it('flags unhealthy when last tick is older than 2× the interval', () => {
      const result = evaluateHealth({
        scheduler: fakeScheduler({
          running: true,
          lastTickAt: Date.now() - 5 * 60_000, // way past 2× the 60s interval
          intervalMs: 60_000
        })
      });
      expect(result.status).toBe('unhealthy');
      expect(result.ok).toBe(false);
      expect(result.checks.scheduler.status).toBe('fail');
    });

    it('reports degraded when scheduler probe itself throws', () => {
      const result = evaluateHealth({
        scheduler: {
          isRunning: () => { throw new Error('scheduler exploded'); },
          getLastTickAt: () => Date.now()
        }
      });
      expect(result.status).toBe('degraded');
      expect(result.checks.scheduler.status).toBe('error');
      expect(result.checks.scheduler.detail).toBe('scheduler exploded');
    });
  });

  describe('kv probe', () => {
    it('passes when ping() succeeds', () => {
      const result = evaluateHealth({ kv: { ping: () => {} } });
      expect(result.status).toBe('healthy');
      expect(result.checks.kv.ok).toBe(true);
    });

    it('flags unhealthy when ping() throws', () => {
      const result = evaluateHealth({
        kv: { ping: () => { throw new Error('SQLITE_BUSY'); } }
      });
      expect(result.status).toBe('unhealthy');
      expect(result.ok).toBe(false);
      expect(result.checks.kv.status).toBe('fail');
      expect(result.checks.kv.detail).toBe('SQLITE_BUSY');
    });

    it('skips the check when ping is not callable', () => {
      const result = evaluateHealth({ kv: {} });
      expect(result.checks.kv).toBeUndefined();
    });
  });

  describe('disk probe', () => {
    it('passes for a real directory with plenty of free space', () => {
      // /tmp is virtually always > 100 MB free on dev/CI hosts.
      const result = evaluateHealth({ dataDir: '/tmp' });
      expect(result.checks.disk.ok).toBe(true);
      expect(result.checks.disk.detail.freeBytes).toBeGreaterThan(0);
    });

    it('reports degraded when statfs throws (e.g. nonexistent path)', () => {
      const result = evaluateHealth({ dataDir: '/this/path/does/not/exist/temper' });
      expect(result.checks.disk.status).toBe('error');
      expect(result.status).toBe('degraded');
    });
  });

  it('combines unhealthy + degraded → unhealthy (most-severe wins)', () => {
    const result = evaluateHealth({
      kv: { ping: () => { throw new Error('down'); } },     // unhealthy
      dataDir: '/this/does/not/exist'                          // degraded
    });
    expect(result.status).toBe('unhealthy');
    expect(result.ok).toBe(false);
  });
});
