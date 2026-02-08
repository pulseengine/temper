const { registerApp, mapLegacyEnvVars } = require('../../src/app');

describe('app', () => {
  describe('mapLegacyEnvVars', () => {
    const origEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...origEnv };
    });

    it('maps GITHUB_APP_ID to APP_ID', () => {
      process.env.GITHUB_APP_ID = '12345';
      delete process.env.APP_ID;
      mapLegacyEnvVars();
      expect(process.env.APP_ID).toBe('12345');
    });

    it('does not overwrite existing APP_ID', () => {
      process.env.GITHUB_APP_ID = '12345';
      process.env.APP_ID = '99999';
      mapLegacyEnvVars();
      expect(process.env.APP_ID).toBe('99999');
    });

    it('maps GITHUB_PRIVATE_KEY to PRIVATE_KEY', () => {
      process.env.GITHUB_PRIVATE_KEY = 'secret-key';
      delete process.env.PRIVATE_KEY;
      mapLegacyEnvVars();
      expect(process.env.PRIVATE_KEY).toBe('secret-key');
    });

    it('does not overwrite existing PRIVATE_KEY', () => {
      process.env.GITHUB_PRIVATE_KEY = 'new-key';
      process.env.PRIVATE_KEY = 'old-key';
      mapLegacyEnvVars();
      expect(process.env.PRIVATE_KEY).toBe('old-key');
    });

    it('maps GITHUB_WEBHOOK_SECRET to WEBHOOK_SECRET', () => {
      process.env.GITHUB_WEBHOOK_SECRET = 'my-secret';
      delete process.env.WEBHOOK_SECRET;
      mapLegacyEnvVars();
      expect(process.env.WEBHOOK_SECRET).toBe('my-secret');
    });

    it('sets default WEBHOOK_PATH', () => {
      delete process.env.WEBHOOK_PATH;
      mapLegacyEnvVars();
      expect(process.env.WEBHOOK_PATH).toBe('/api/github/webhooks');
    });

    it('does not overwrite existing WEBHOOK_PATH', () => {
      process.env.WEBHOOK_PATH = '/custom/path';
      mapLegacyEnvVars();
      expect(process.env.WEBHOOK_PATH).toBe('/custom/path');
    });
  });

  describe('registerApp', () => {
    it('registers event handlers and routes', () => {
      const handlers = {};
      const app = {
        on: jest.fn((event, handler) => { handlers[event] = handler; }),
        onError: jest.fn()
      };
      const routeHandlers = {};
      const mockRouter = {
        get: jest.fn((path, handler) => { routeHandlers[path] = handler; })
      };
      const getRouter = jest.fn().mockReturnValue(mockRouter);

      registerApp(app, { getRouter });

      expect(app.on).toHaveBeenCalledWith('repository.created', expect.any(Function));
      expect(app.on).toHaveBeenCalledWith('issue_comment.created', expect.any(Function));
      expect(app.onError).toHaveBeenCalled();
      expect(getRouter).toHaveBeenCalledWith('/');
      expect(mockRouter.get).toHaveBeenCalledWith('/health', expect.any(Function));
      expect(mockRouter.get).toHaveBeenCalledWith('/webhook', expect.any(Function));
    });

    it('works without getRouter option', () => {
      const app = {
        on: jest.fn(),
        onError: jest.fn()
      };

      // Should not throw when getRouter is undefined
      expect(() => registerApp(app)).not.toThrow();
      expect(app.on).toHaveBeenCalledTimes(2);
      expect(app.onError).toHaveBeenCalledTimes(1);
    });

    it('health endpoint returns correct response', () => {
      const app = {
        on: jest.fn(),
        onError: jest.fn()
      };
      const routeHandlers = {};
      const mockRouter = {
        get: jest.fn((path, handler) => { routeHandlers[path] = handler; })
      };
      const getRouter = jest.fn().mockReturnValue(mockRouter);

      registerApp(app, { getRouter });

      // Simulate calling the health endpoint
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      routeHandlers['/health']({}, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'healthy',
          version: '1.0.0'
        })
      );
    });

    it('webhook endpoint returns correct response', () => {
      const app = {
        on: jest.fn(),
        onError: jest.fn()
      };
      const routeHandlers = {};
      const mockRouter = {
        get: jest.fn((path, handler) => { routeHandlers[path] = handler; })
      };
      const getRouter = jest.fn().mockReturnValue(mockRouter);

      registerApp(app, { getRouter });

      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };
      routeHandlers['/webhook']({}, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Webhook endpoint ready',
          events: expect.arrayContaining(['repository', 'issue_comment'])
        })
      );
    });
  });
});
