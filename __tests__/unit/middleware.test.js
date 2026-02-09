jest.mock('helmet', () => {
  const mockMiddleware = jest.fn();
  const mockFn = jest.fn(() => mockMiddleware);
  return {
    __esModule: true,
    default: mockFn,
    _mockFn: mockFn
  };
});

import { applySecurityMiddleware } from '../../src/middleware.js';
import { _mockFn } from 'helmet';

describe('middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('applySecurityMiddleware', () => {
    it('calls router.use with helmet middleware', () => {
      const mockRouter = { use: jest.fn() };

      applySecurityMiddleware(mockRouter);

      expect(_mockFn).toHaveBeenCalledTimes(1);
      expect(_mockFn).toHaveBeenCalledWith({
        contentSecurityPolicy: false,
        crossOriginEmbedderPolicy: false
      });
      expect(mockRouter.use).toHaveBeenCalledTimes(1);
      expect(mockRouter.use).toHaveBeenCalledWith(_mockFn.mock.results[0].value);
    });

    it('does nothing when router.use is not a function', () => {
      const mockRouter = { use: 'not-a-function' };

      applySecurityMiddleware(mockRouter);

      expect(_mockFn).not.toHaveBeenCalled();
    });

    it('does nothing when router has no use property', () => {
      const mockRouter = {};

      applySecurityMiddleware(mockRouter);

      expect(_mockFn).not.toHaveBeenCalled();
    });

    it('does nothing when router.use is undefined', () => {
      const mockRouter = { use: undefined };

      applySecurityMiddleware(mockRouter);

      expect(_mockFn).not.toHaveBeenCalled();
    });

    it('does nothing when router.use is null', () => {
      const mockRouter = { use: null };

      applySecurityMiddleware(mockRouter);

      expect(_mockFn).not.toHaveBeenCalled();
    });
  });
});
