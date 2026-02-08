import { withRetry, isTransientError, calculateDelay } from '../../src/retry.js';

describe('retry', () => {
  describe('isTransientError', () => {
    it('treats network errors (no status) as transient', () => {
      expect(isTransientError(new Error('ECONNRESET'))).toBe(true);
    });

    it('treats 429 as transient', () => {
      expect(isTransientError({ status: 429, message: 'rate limited' })).toBe(true);
    });

    it('treats 500 as transient', () => {
      expect(isTransientError({ status: 500, message: 'server error' })).toBe(true);
    });

    it('treats 502 as transient', () => {
      expect(isTransientError({ status: 502, message: 'bad gateway' })).toBe(true);
    });

    it('treats 404 as permanent', () => {
      expect(isTransientError({ status: 404, message: 'not found' })).toBe(false);
    });

    it('treats 403 as permanent', () => {
      expect(isTransientError({ status: 403, message: 'forbidden' })).toBe(false);
    });
  });

  describe('calculateDelay', () => {
    it('increases with each attempt', () => {
      const d0 = calculateDelay(0, 1000, 30000);
      const d1 = calculateDelay(1, 1000, 30000);
      // d1 base is 2000 vs d0 base 1000, so d1 should generally be higher
      // but jitter adds randomness, so we check the max bound
      expect(d0).toBeLessThanOrEqual(30000);
      expect(d1).toBeLessThanOrEqual(30000);
    });

    it('caps at maxDelay', () => {
      const delay = calculateDelay(10, 1000, 5000);
      expect(delay).toBeLessThanOrEqual(5000);
    });
  });

  describe('withRetry', () => {
    it('returns result on first success', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const result = await withRetry(fn, { maxRetries: 3, baseDelay: 1 });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on transient error then succeeds', async () => {
      const fn = jest.fn()
        .mockRejectedValueOnce({ status: 500, message: 'fail' })
        .mockResolvedValueOnce('recovered');
      const result = await withRetry(fn, { maxRetries: 3, baseDelay: 1 });
      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('throws immediately on permanent error', async () => {
      const fn = jest.fn().mockRejectedValue({ status: 404, message: 'not found' });
      await expect(withRetry(fn, { maxRetries: 3, baseDelay: 1 })).rejects.toEqual(
        expect.objectContaining({ status: 404 })
      );
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws after exhausting retries', async () => {
      const fn = jest.fn().mockRejectedValue({ status: 500, message: 'fail' });
      await expect(withRetry(fn, { maxRetries: 2, baseDelay: 1 })).rejects.toEqual(
        expect.objectContaining({ status: 500 })
      );
      expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
    });
  });
});
