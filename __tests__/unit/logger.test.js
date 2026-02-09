import { getLogger, setLogger, resetLogger, defaultLogger } from '../../src/logger.js';

describe('logger', () => {
  afterEach(() => {
    resetLogger();
  });

  describe('defaultLogger', () => {
    it('is a pino logger instance', () => {
      expect(defaultLogger).toBeDefined();
      expect(typeof defaultLogger.info).toBe('function');
      expect(typeof defaultLogger.error).toBe('function');
      expect(typeof defaultLogger.warn).toBe('function');
      expect(typeof defaultLogger.debug).toBe('function');
    });
  });

  describe('getLogger', () => {
    it('returns the default logger initially', () => {
      const logger = getLogger();
      expect(logger).toBe(defaultLogger);
    });

    it('returns a custom logger after setLogger is called', () => {
      const mockLogger = { info: jest.fn(), error: jest.fn() };
      setLogger(mockLogger);
      expect(getLogger()).toBe(mockLogger);
    });
  });

  describe('setLogger', () => {
    it('sets a custom logger', () => {
      const mockLogger = { info: jest.fn() };
      setLogger(mockLogger);
      expect(getLogger()).toBe(mockLogger);
    });

    it('falls back to default logger when called with null', () => {
      const mockLogger = { info: jest.fn() };
      setLogger(mockLogger);
      expect(getLogger()).toBe(mockLogger);

      setLogger(null);
      expect(getLogger()).toBe(defaultLogger);
    });

    it('falls back to default logger when called with undefined', () => {
      const mockLogger = { info: jest.fn() };
      setLogger(mockLogger);
      expect(getLogger()).toBe(mockLogger);

      setLogger(undefined);
      expect(getLogger()).toBe(defaultLogger);
    });

    it('falls back to default logger when called with empty string', () => {
      setLogger('');
      expect(getLogger()).toBe(defaultLogger);
    });

    it('falls back to default logger when called with 0', () => {
      setLogger(0);
      expect(getLogger()).toBe(defaultLogger);
    });

    it('accepts any truthy value as a logger', () => {
      const customLogger = { custom: true };
      setLogger(customLogger);
      expect(getLogger()).toBe(customLogger);
    });
  });

  describe('resetLogger', () => {
    it('restores the default logger after a custom one was set', () => {
      const mockLogger = { info: jest.fn() };
      setLogger(mockLogger);
      expect(getLogger()).toBe(mockLogger);

      resetLogger();
      expect(getLogger()).toBe(defaultLogger);
    });

    it('is idempotent when called multiple times', () => {
      resetLogger();
      resetLogger();
      expect(getLogger()).toBe(defaultLogger);
    });
  });
});
