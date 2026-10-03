/**
 * Bug #3 — bearer-token gate on /api/* and /dashboard/actions/*.
 *
 * The dashboard handler is a 1500-line module that pulls in real GitHub
 * clients on import. We jest.mock the heavy collaborators so this unit
 * test only exercises the auth path: handler entry, before any GitHub
 * call.
 */

jest.mock('../../src/organization.js', () => ({
  analyzeOrganizationRepositories: jest.fn(),
  synchronizeAllRepositories: jest.fn(),
  generateOrganizationAnalysisReport: jest.fn()
}));
jest.mock('../../src/dependabot.js', () => ({
  checkDependabotConfiguration: jest.fn(),
  checkExistingDependabotConfig: jest.fn(),
  fixDependabotPRLabels: jest.fn()
}));
jest.mock('../../src/reporting.js', () => ({
  generateConfigurationReport: jest.fn()
}));
jest.mock('../../src/ai-review.js', () => ({
  getReviews: jest.fn(),
  getReviewStats: jest.fn(),
  reviewPullRequest: jest.fn()
}));
jest.mock('../../src/config.js', () => ({
  getConfig: jest.fn(() => ({}))
}));
jest.mock('../../src/logger.js', () => ({
  getLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }))
}));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));

import { createDashboardHandler } from '../../src/dashboard.js';

function mockReq(method, path, headers = {}) {
  return { method, url: path, headers: { host: 'localhost:3000', ...headers } };
}

function mockRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: '',
    writeHead: jest.fn((code, headers) => { res.statusCode = code; res.headers = { ...res.headers, ...(headers || {}) }; return res; }),
    end: jest.fn((body) => { res.body = body || ''; }),
    setHeader: jest.fn((k, v) => { res.headers[k] = v; })
  };
  return res;
}

describe('dashboard auth gate (Bug #3)', () => {
  let handler;
  const ORIG_TOKEN = process.env.DASHBOARD_TOKEN;

  beforeEach(() => {
    handler = createDashboardHandler();
  });

  afterEach(() => {
    if (ORIG_TOKEN === undefined) delete process.env.DASHBOARD_TOKEN;
    else process.env.DASHBOARD_TOKEN = ORIG_TOKEN;
  });

  describe('when DASHBOARD_TOKEN is unset', () => {
    beforeEach(() => { delete process.env.DASHBOARD_TOKEN; });

    it('rejects POST /dashboard/actions/sync with 503', async () => {
      const req = mockReq('POST', '/dashboard/actions/sync');
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(503);
      expect(JSON.parse(res.body)).toEqual({ success: false, error: 'auth_unconfigured' });
    });

    it('rejects GET /api/org/repos with 503', async () => {
      const req = mockReq('GET', '/api/org/repos');
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(503);
    });

    it('lets the public /dashboard HTML page through', async () => {
      const req = mockReq('GET', '/dashboard');
      const res = mockRes();
      await handler(req, res);
      // Whatever the page renders, it must NOT be 503/401 from the auth gate.
      expect(res.statusCode).not.toBe(503);
      expect(res.statusCode).not.toBe(401);
    });
  });

  describe('when DASHBOARD_TOKEN is set', () => {
    beforeEach(() => { process.env.DASHBOARD_TOKEN = 'secret-token-123'; });

    it('rejects /api/org/repos without an Authorization header', async () => {
      const req = mockReq('GET', '/api/org/repos');
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(401);
      expect(res.headers['WWW-Authenticate']).toMatch(/^Bearer/);
    });

    it('rejects /api/org/repos with a wrong bearer', async () => {
      const req = mockReq('GET', '/api/org/repos', { authorization: 'Bearer wrong' });
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(401);
    });

    it('rejects with the wrong scheme (Basic instead of Bearer)', async () => {
      const req = mockReq('GET', '/api/org/repos', { authorization: 'Basic c2VjcmV0' });
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).toBe(401);
    });

    it('accepts a valid Bearer token (passes the gate, lets handler run)', async () => {
      const req = mockReq('GET', '/api/org/health', { authorization: 'Bearer secret-token-123' });
      const res = mockRes();
      await handler(req, res);
      // The downstream handler may still return 200 or 500 (mocked
      // dependencies). The point is that the auth gate let us through —
      // i.e., we did NOT get 401 / 503.
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(503);
    });

    it('reads the Node-normalised lowercase `authorization` header', async () => {
      // Node's HTTP layer always lowercases incoming header names; we read
      // `req.headers.authorization` accordingly. This test guards against
      // a future refactor that accidentally switches to camelCase lookup.
      const req = mockReq('GET', '/api/org/repos', { authorization: 'Bearer secret-token-123' });
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).not.toBe(401);
    });

    it('lets /dashboard HTML through without a token', async () => {
      const req = mockReq('GET', '/dashboard');
      const res = mockRes();
      await handler(req, res);
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).not.toBe(503);
    });

    it('rejects all four POST action routes consistently', async () => {
      const routes = [
        '/dashboard/actions/sync',
        '/dashboard/actions/review',
        '/dashboard/actions/analyze-org',
        '/dashboard/actions/refresh'
      ];
      for (const path of routes) {
        const req = mockReq('POST', path);
        const res = mockRes();
        await handler(req, res);
        expect(res.statusCode).toBe(401);
      }
    });
  });
});
