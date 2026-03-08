// jest.mock() calls are hoisted by babel above all other code, so factories
// must be self-contained.  Variables referenced inside factories MUST be
// prefixed with "mock" (case-insensitive).

jest.mock('../../src/repository.js', () => ({
  configureRepository: jest.fn()
}));

jest.mock('../../src/organization.js', () => ({
  checkOrganizationMembership: jest.fn(),
  synchronizeAllRepositories: jest.fn(),
  generateOrganizationAnalysisReport: jest.fn()
}));

jest.mock('../../src/reporting.js', () => ({
  generateConfigurationReport: jest.fn()
}));

jest.mock('../../src/dependabot.js', () => ({
  checkDependabotConfiguration: jest.fn(),
  checkExistingDependabotConfig: jest.fn(),
  extractLabelsFromConfig: jest.fn().mockReturnValue([]),
  fixDependabotPRLabels: jest.fn(),
  generateDependabotConfig: jest.fn(),
  applyDependabotConfig: jest.fn()
}));

jest.mock('../../src/labels.js', () => ({
  ensureLabelsExist: jest.fn().mockResolvedValue(undefined),
  synchronizeIssueLabels: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../../src/merge-strategy.js', () => ({
  handleSignedCommitMerge: jest.fn(),
  checkPRMergeStrategy: jest.fn()
}));

jest.mock('../../src/ai-review.js', () => ({
  reviewPullRequest: jest.fn(),
  updateReviewStatus: jest.fn()
}));

jest.mock('../../src/idempotency.js', () => ({
  isProcessed: jest.fn(),
  markProcessed: jest.fn()
}));

jest.mock('../../src/queue.js', () => ({
  defaultQueue: { stats: jest.fn().mockReturnValue({ pending: 0, active: 0, completed: 0, failed: 0 }) }
}));

jest.mock('../../src/middleware.js', () => ({
  applySecurityMiddleware: jest.fn()
}));

jest.mock('../../src/task-store.js', () => ({
  initTaskStore: jest.fn()
}));

jest.mock('../../src/scheduler.js', () => ({
  createScheduler: jest.fn()
}));

jest.mock('../../src/logger.js', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    getLogger: jest.fn(() => mockLogger),
    setLogger: jest.fn()
  };
});

import { registerApp, mapLegacyEnvVars } from '../../src/app.js';
import { _setConfigForTesting } from '../../src/config.js';
import { configureRepository } from '../../src/repository.js';
import {
  checkOrganizationMembership,
  synchronizeAllRepositories,
  generateOrganizationAnalysisReport
} from '../../src/organization.js';
import { generateConfigurationReport } from '../../src/reporting.js';
import {
  checkDependabotConfiguration,
  checkExistingDependabotConfig,
  fixDependabotPRLabels,
  generateDependabotConfig,
  applyDependabotConfig
} from '../../src/dependabot.js';
import { handleSignedCommitMerge, checkPRMergeStrategy } from '../../src/merge-strategy.js';
import { reviewPullRequest } from '../../src/ai-review.js';
import { isProcessed, markProcessed } from '../../src/idempotency.js';
import { defaultQueue } from '../../src/queue.js';
import { applySecurityMiddleware } from '../../src/middleware.js';
import { getLogger, setLogger } from '../../src/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Register the app, capture the event handlers and route handlers, and return
 * them for the tests to invoke directly.
 */
function setupApp(options = {}) {
  const handlers = {};
  let errorHandler = null;
  const app = {
    on: jest.fn((event, handler) => { handlers[event] = handler; }),
    onError: jest.fn((handler) => { errorHandler = handler; })
  };
  const routeHandlers = {};
  const mockRouter = {
    get: jest.fn((path, handler) => { routeHandlers[path] = handler; }),
    use: jest.fn()
  };

  // Support three modes:
  // 1. getRouter (legacy/Express) - default
  // 2. addHandler (Probot v14 raw HTTP handlers)
  // 3. skipRouter - no routing at all
  const addedHandlers = [];
  const mockAddHandler = jest.fn((handler) => { addedHandlers.push(handler); });
  let getRouter;
  let secondArg;

  if (options.useAddHandler) {
    secondArg = { addHandler: mockAddHandler };
  } else if (options.skipRouter) {
    secondArg = undefined;
  } else {
    getRouter = jest.fn().mockReturnValue(mockRouter);
    secondArg = { getRouter };
  }

  registerApp(app, secondArg);

  return { app, handlers, errorHandler, routeHandlers, mockRouter, getRouter, addedHandlers, mockAddHandler };
}

function createMockOctokit() {
  return {
    issues: {
      create: jest.fn().mockResolvedValue({ data: { number: 42 } }),
      createComment: jest.fn().mockResolvedValue({ data: { id: 100 } }),
      updateComment: jest.fn().mockResolvedValue({}),
      deleteComment: jest.fn().mockResolvedValue({})
    },
    repos: {
      getBranch: jest.fn().mockResolvedValue({ data: { name: 'main' } })
    },
    request: jest.fn().mockResolvedValue({ status: 200, data: {} })
  };
}

function createRepoCreatedContext(overrides = {}) {
  const octokit = createMockOctokit();
  return {
    id: overrides.id ?? 'delivery-1',
    log: overrides.log ?? { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    octokit,
    payload: {
      repository: {
        full_name: 'pulseengine/test-repo',
        name: 'test-repo',
        has_issues: true,
        default_branch: 'main',
        owner: { login: 'pulseengine' },
        ...(overrides.repository || {})
      },
      organization: { login: 'pulseengine', ...(overrides.organization || {}) }
    },
    ...overrides
  };
}

function createIssueCommentContext(command, overrides = {}) {
  const octokit = createMockOctokit();
  return {
    id: overrides.id ?? 'delivery-2',
    log: overrides.log ?? { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    octokit,
    payload: {
      comment: { body: command },
      repository: {
        full_name: 'myorg/myrepo',
        name: 'myrepo',
        owner: { login: 'myorg' }
      },
      sender: { login: 'someuser', ...(overrides.sender || {}) },
      issue: { number: 7, ...(overrides.issue || {}) }
    },
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('app', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset mock implementations to safe defaults so mockRejectedValue from
    // a previous test does not leak.
    isProcessed.mockReturnValue(false);
    markProcessed.mockReturnValue(undefined);
    configureRepository.mockResolvedValue({ success: true });
    checkOrganizationMembership.mockResolvedValue(true);
    synchronizeAllRepositories.mockResolvedValue({ success: true, repositoriesProcessed: 5 });
    generateOrganizationAnalysisReport.mockResolvedValue('# Analysis Report');
    generateConfigurationReport.mockResolvedValue('# Config Report');
    checkDependabotConfiguration.mockResolvedValue('# Dependabot Report');
    checkExistingDependabotConfig.mockResolvedValue({ labelIssues: [] });
    fixDependabotPRLabels.mockResolvedValue({ success: true, fixedIssues: 0 });
    handleSignedCommitMerge.mockResolvedValue({ success: true, action: 'no_change_needed', message: 'ok' });
    checkPRMergeStrategy.mockResolvedValue({
      prTitle: 'My PR',
      baseBranch: 'main',
      hasSignedCommits: false,
      currentMergeStrategy: { allowMergeCommit: false, allowSquashMerge: false, allowRebaseMerge: true },
      commitCount: 2,
      signedCommitCount: 0
    });
    reviewPullRequest.mockResolvedValue({ success: true });
    _setConfigForTesting({});
  });

  afterEach(() => {
    _setConfigForTesting({});
  });

  // =========================================================================
  // mapLegacyEnvVars
  // =========================================================================
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

    it('does not overwrite existing WEBHOOK_SECRET', () => {
      process.env.GITHUB_WEBHOOK_SECRET = 'new-secret';
      process.env.WEBHOOK_SECRET = 'old-secret';
      mapLegacyEnvVars();
      expect(process.env.WEBHOOK_SECRET).toBe('old-secret');
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

    it('does nothing when legacy vars are absent', () => {
      delete process.env.GITHUB_APP_ID;
      delete process.env.GITHUB_PRIVATE_KEY;
      delete process.env.GITHUB_WEBHOOK_SECRET;
      process.env.WEBHOOK_PATH = '/already-set';
      mapLegacyEnvVars();
      expect(process.env.APP_ID).toBeUndefined();
      expect(process.env.PRIVATE_KEY).toBeUndefined();
      expect(process.env.WEBHOOK_SECRET).toBeUndefined();
    });
  });

  // =========================================================================
  // registerApp - wiring
  // =========================================================================
  describe('registerApp', () => {
    it('registers event handlers and routes', () => {
      const { app, getRouter, mockRouter } = setupApp();

      expect(app.on).toHaveBeenCalledWith('repository.created', expect.any(Function));
      expect(app.on).toHaveBeenCalledWith('issue_comment.created', expect.any(Function));
      expect(app.onError).toHaveBeenCalledWith(expect.any(Function));
      expect(getRouter).toHaveBeenCalledWith('/');
      expect(applySecurityMiddleware).toHaveBeenCalledWith(mockRouter);
      expect(mockRouter.get).toHaveBeenCalledWith('/health', expect.any(Function));
      expect(mockRouter.get).toHaveBeenCalledWith('/webhook', expect.any(Function));
    });

    it('works without getRouter option', () => {
      const { app } = setupApp({ skipRouter: true });
      expect(app.on).toHaveBeenCalledTimes(5);
      expect(app.onError).toHaveBeenCalledTimes(1);
    });

    it('health endpoint returns correct response', () => {
      const { routeHandlers } = setupApp();
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      routeHandlers['/health']({}, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'healthy', version: expect.any(String) })
      );
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({ queue: expect.any(Object) })
      );
    });

    it('health endpoint includes queue stats', () => {
      defaultQueue.stats.mockReturnValue({ pending: 2, active: 1, completed: 10, failed: 1 });
      const { routeHandlers } = setupApp();
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      routeHandlers['/health']({}, mockRes);

      const response = mockRes.json.mock.calls[0][0];
      expect(response.queue).toEqual({ pending: 2, active: 1, completed: 10, failed: 1 });
    });

    it('webhook endpoint returns correct response', () => {
      const { routeHandlers } = setupApp();
      const mockRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      routeHandlers['/webhook']({}, mockRes);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Webhook endpoint ready',
          events: expect.arrayContaining(['repository', 'issue_comment', 'pull_request', 'push'])
        })
      );
    });

    it('error handler logs the error', () => {
      const { errorHandler } = setupApp();
      const error = new Error('something went wrong');
      errorHandler(error);

      expect(getLogger().error).toHaveBeenCalledWith({ err: error }, 'Probot error');
    });
  });

  // =========================================================================
  // registerApp - addHandler (Probot v14)
  // =========================================================================
  describe('registerApp with addHandler (Probot v14)', () => {
    function createMockReq(method, url) {
      return { method, url, headers: { host: 'localhost:3000' } };
    }

    function createMockRes() {
      const res = {
        setHeader: jest.fn(),
        writeHead: jest.fn().mockReturnThis(),
        end: jest.fn()
      };
      return res;
    }

    it('registers a handler via addHandler when getRouter is absent', () => {
      const { mockAddHandler, addedHandlers } = setupApp({ useAddHandler: true });

      expect(mockAddHandler).toHaveBeenCalledTimes(2);
      expect(addedHandlers).toHaveLength(2);
      expect(typeof addedHandlers[0]).toBe('function');
    });

    it('does not call addHandler when getRouter is present', () => {
      const { mockAddHandler } = setupApp();

      // mockAddHandler is created but never passed to registerApp in getRouter mode
      // getRouter takes precedence, so addHandler should not be used
      expect(mockAddHandler).not.toHaveBeenCalled();
    });

    it('health endpoint returns correct JSON via addHandler', async () => {
      const { addedHandlers } = setupApp({ useAddHandler: true });
      const handler = addedHandlers[0];
      const req = createMockReq('GET', '/health');
      const res = createMockRes();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.status).toBe('healthy');
      expect(typeof body.version).toBe('string');
      expect(body.queue).toBeDefined();
      expect(body.timestamp).toBeDefined();
    });

    it('health endpoint includes queue stats via addHandler', async () => {
      defaultQueue.stats.mockReturnValue({ pending: 3, active: 2, completed: 15, failed: 0 });
      const { addedHandlers } = setupApp({ useAddHandler: true });
      const handler = addedHandlers[0];
      const req = createMockReq('GET', '/health');
      const res = createMockRes();

      await handler(req, res);

      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.queue).toEqual({ pending: 3, active: 2, completed: 15, failed: 0 });
    });

    it('webhook endpoint returns correct JSON via addHandler', async () => {
      const { addedHandlers } = setupApp({ useAddHandler: true });
      const handler = addedHandlers[0];
      const req = createMockReq('GET', '/webhook');
      const res = createMockRes();

      const handled = await handler(req, res);

      expect(handled).toBe(true);
      expect(res.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' });
      const body = JSON.parse(res.end.mock.calls[0][0]);
      expect(body.message).toBe('Webhook endpoint ready');
      expect(body.events).toEqual(expect.arrayContaining(['repository', 'issue_comment', 'pull_request', 'push']));
    });

    it('applies security headers on health endpoint', async () => {
      const { addedHandlers } = setupApp({ useAddHandler: true });
      const handler = addedHandlers[0];
      const req = createMockReq('GET', '/health');
      const res = createMockRes();

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
      expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'SAMEORIGIN');
      expect(res.setHeader).toHaveBeenCalledWith('X-XSS-Protection', '0');
    });

    it('applies security headers on webhook endpoint', async () => {
      const { addedHandlers } = setupApp({ useAddHandler: true });
      const handler = addedHandlers[0];
      const req = createMockReq('GET', '/webhook');
      const res = createMockRes();

      await handler(req, res);

      expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
      expect(res.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'SAMEORIGIN');
      expect(res.setHeader).toHaveBeenCalledWith('X-XSS-Protection', '0');
    });

    it('returns false for unhandled routes', async () => {
      const { addedHandlers } = setupApp({ useAddHandler: true });
      const handler = addedHandlers[0];
      const req = createMockReq('GET', '/unknown');
      const res = createMockRes();

      const handled = await handler(req, res);

      expect(handled).toBe(false);
      expect(res.writeHead).not.toHaveBeenCalled();
      expect(res.end).not.toHaveBeenCalled();
    });

    it('returns false for POST to /health', async () => {
      const { addedHandlers } = setupApp({ useAddHandler: true });
      const handler = addedHandlers[0];
      const req = createMockReq('POST', '/health');
      const res = createMockRes();

      const handled = await handler(req, res);

      expect(handled).toBe(false);
    });

    it('returns false for POST to /webhook', async () => {
      const { addedHandlers } = setupApp({ useAddHandler: true });
      const handler = addedHandlers[0];
      const req = createMockReq('POST', '/webhook');
      const res = createMockRes();

      const handled = await handler(req, res);

      expect(handled).toBe(false);
    });
  });

  // =========================================================================
  // repository.created handler
  // =========================================================================
  describe('repository.created', () => {
    it('sets logger from context.log', async () => {
      const { handlers } = setupApp();
      const context = createRepoCreatedContext();
      await handlers['repository.created'](context);

      expect(setLogger).toHaveBeenCalledWith(context.log);
    });

    it('skips duplicate webhook delivery', async () => {
      isProcessed.mockReturnValue(true);
      const { handlers } = setupApp();
      const context = createRepoCreatedContext();
      await handlers['repository.created'](context);

      expect(getLogger().info).toHaveBeenCalledWith(
        { deliveryId: 'delivery-1' },
        'Skipping duplicate webhook delivery'
      );
      expect(configureRepository).not.toHaveBeenCalled();
    });

    it('configures matching org repo and creates success issue', async () => {
      _setConfigForTesting({ organization: 'pulseengine' });
      configureRepository.mockResolvedValue({ success: true });
      const { handlers } = setupApp();
      const context = createRepoCreatedContext();
      await handlers['repository.created'](context);

      expect(configureRepository).toHaveBeenCalledWith(
        context.octokit, context.payload.repository, undefined, { enqueueTask: null }
      );
      expect(context.octokit.issues.create).toHaveBeenCalledWith(
        expect.objectContaining({
          owner: 'pulseengine',
          repo: 'test-repo',
          title: 'Repository Configuration',
          labels: ['automation', 'configuration']
        })
      );
      // Body should include success message
      const body = context.octokit.issues.create.mock.calls[0][0].body;
      expect(body).toContain('automatically configured');
    });

    it('creates failure issue when configureRepository fails', async () => {
      _setConfigForTesting({ organization: 'pulseengine' });
      configureRepository.mockResolvedValue({ success: false, error: 'API timeout' });
      const { handlers } = setupApp();
      const context = createRepoCreatedContext();
      await handlers['repository.created'](context);

      const body = context.octokit.issues.create.mock.calls[0][0].body;
      expect(body).toContain('Configuration failed: API timeout');
    });

    it('skips issue creation when has_issues is false', async () => {
      _setConfigForTesting({ organization: 'pulseengine' });
      const { handlers } = setupApp();
      const context = createRepoCreatedContext({
        repository: { has_issues: false }
      });
      await handlers['repository.created'](context);

      expect(configureRepository).toHaveBeenCalled();
      expect(context.octokit.issues.create).not.toHaveBeenCalled();
    });

    it('skips configuration when org does not match', async () => {
      _setConfigForTesting({ organization: 'pulseengine' });
      const { handlers } = setupApp();
      const context = createRepoCreatedContext({
        organization: { login: 'other-org' },
        repository: { owner: { login: 'other-org' } }
      });
      await handlers['repository.created'](context);

      expect(configureRepository).not.toHaveBeenCalled();
    });

    it('uses ORGANIZATION env var as fallback', async () => {
      const origOrg = process.env.ORGANIZATION;
      process.env.ORGANIZATION = 'env-org';
      _setConfigForTesting({});
      const { handlers } = setupApp();
      const context = createRepoCreatedContext({
        organization: { login: 'env-org' },
        repository: { owner: { login: 'env-org' }, name: 'repo1', full_name: 'env-org/repo1', has_issues: false }
      });
      await handlers['repository.created'](context);

      expect(configureRepository).toHaveBeenCalled();
      process.env.ORGANIZATION = origOrg;
    });

    it('skips when no config org or env var is set', async () => {
      const origOrg = process.env.ORGANIZATION;
      delete process.env.ORGANIZATION;
      _setConfigForTesting({});
      const { handlers } = setupApp();
      const context = createRepoCreatedContext();
      await handlers['repository.created'](context);

      expect(configureRepository).not.toHaveBeenCalled();
      process.env.ORGANIZATION = origOrg;
    });

    it('uses repository.owner.login when organization is missing', async () => {
      _setConfigForTesting({ organization: 'pulseengine' });
      const { handlers } = setupApp();
      const context = createRepoCreatedContext();
      // Remove organization from payload
      delete context.payload.organization;
      await handlers['repository.created'](context);

      expect(configureRepository).toHaveBeenCalled();
    });

    it('marks delivery as processed', async () => {
      _setConfigForTesting({ organization: 'pulseengine' });
      const { handlers } = setupApp();
      const context = createRepoCreatedContext();
      await handlers['repository.created'](context);

      expect(markProcessed).toHaveBeenCalledWith('delivery-1');
    });

    it('does not call markProcessed when deliveryId is undefined', async () => {
      const { handlers } = setupApp();
      const context = createRepoCreatedContext({ id: undefined });
      await handlers['repository.created'](context);

      expect(markProcessed).not.toHaveBeenCalled();
    });

    it('does not call setLogger when context.log is falsy', async () => {
      const { handlers } = setupApp();
      const context = createRepoCreatedContext({ log: null });
      await handlers['repository.created'](context);

      expect(setLogger).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // issue_comment.created handler - shared behavior
  // =========================================================================
  describe('issue_comment.created', () => {
    describe('shared pre-checks', () => {
      it('sets logger from context.log', async () => {
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/configure-repo');
        await handlers['issue_comment.created'](context);

        expect(setLogger).toHaveBeenCalledWith(context.log);
      });

      it('does not call setLogger when context.log is falsy', async () => {
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/configure-repo', { log: null });
        await handlers['issue_comment.created'](context);

        expect(setLogger).not.toHaveBeenCalled();
      });

      it('skips duplicate webhook delivery', async () => {
        isProcessed.mockReturnValue(true);
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/configure-repo');
        await handlers['issue_comment.created'](context);

        expect(getLogger().info).toHaveBeenCalledWith(
          { deliveryId: 'delivery-2' },
          'Skipping duplicate webhook delivery'
        );
        expect(configureRepository).not.toHaveBeenCalled();
      });

      it('returns early when comment body is null', async () => {
        const { handlers } = setupApp();
        const context = createIssueCommentContext(null);
        context.payload.comment = { body: null };
        await handlers['issue_comment.created'](context);

        expect(configureRepository).not.toHaveBeenCalled();
        expect(markProcessed).not.toHaveBeenCalled();
      });

      it('returns early when comment is null', async () => {
        const { handlers } = setupApp();
        const context = createIssueCommentContext(null);
        context.payload.comment = null;
        await handlers['issue_comment.created'](context);

        expect(configureRepository).not.toHaveBeenCalled();
      });

      it('does nothing for unrecognized commands', async () => {
        const { handlers } = setupApp();
        const context = createIssueCommentContext('just a normal comment');
        await handlers['issue_comment.created'](context);

        expect(configureRepository).not.toHaveBeenCalled();
        expect(synchronizeAllRepositories).not.toHaveBeenCalled();
        expect(markProcessed).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // requireOrgMember helper
    // -----------------------------------------------------------------------
    describe('requireOrgMember (via /configure-repo)', () => {
      it('rejects non-org members with a comment', async () => {
        checkOrganizationMembership.mockResolvedValue(false);
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/configure-repo');
        await handlers['issue_comment.created'](context);

        expect(context.octokit.issues.createComment).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.stringContaining('must be an organization member')
          })
        );
        expect(configureRepository).not.toHaveBeenCalled();
      });

      it('passes org membership check for valid members', async () => {
        checkOrganizationMembership.mockResolvedValue(true);
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/configure-repo');
        await handlers['issue_comment.created'](context);

        expect(checkOrganizationMembership).toHaveBeenCalledWith(
          context.octokit, 'myorg', 'someuser'
        );
        expect(configureRepository).toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // /configure-repo
    // -----------------------------------------------------------------------
    describe('/configure-repo', () => {
      it('configures repository and posts success comment', async () => {
        configureRepository.mockResolvedValue({ success: true });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/configure-repo');
        await handlers['issue_comment.created'](context);

        expect(configureRepository).toHaveBeenCalledWith(
          context.octokit, context.payload.repository, undefined, { enqueueTask: null }
        );
        expect(context.octokit.issues.createComment).toHaveBeenCalledWith(
          expect.objectContaining({
            owner: 'myorg',
            repo: 'myrepo',
            issue_number: 7,
            body: expect.stringContaining('Repository configured')
          })
        );
        expect(markProcessed).toHaveBeenCalledWith('delivery-2');
      });

      it('posts failure comment when configureRepository fails', async () => {
        configureRepository.mockResolvedValue({ success: false, error: 'Permission denied' });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/configure-repo');
        await handlers['issue_comment.created'](context);

        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('Configuration failed: Permission denied');
      });

      it('does not mark processed when deliveryId is absent', async () => {
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/configure-repo', { id: undefined });
        await handlers['issue_comment.created'](context);

        expect(markProcessed).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // /sync-all-repos
    // -----------------------------------------------------------------------
    describe('/sync-all-repos', () => {
      it('synchronizes all repos and posts success comment', async () => {
        synchronizeAllRepositories.mockResolvedValue({ success: true, repositoriesProcessed: 12 });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/sync-all-repos');
        await handlers['issue_comment.created'](context);

        expect(synchronizeAllRepositories).toHaveBeenCalledWith(context.octokit, 'myorg');
        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('Synchronized all repositories');
        expect(body).toContain('12');
        expect(markProcessed).toHaveBeenCalledWith('delivery-2');
      });

      it('uses config organization when set', async () => {
        _setConfigForTesting({ organization: 'config-org' });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/sync-all-repos');
        await handlers['issue_comment.created'](context);

        expect(synchronizeAllRepositories).toHaveBeenCalledWith(context.octokit, 'config-org');
      });

      it('posts failure comment when sync fails', async () => {
        synchronizeAllRepositories.mockResolvedValue({ success: false, error: 'Rate limit exceeded' });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/sync-all-repos');
        await handlers['issue_comment.created'](context);

        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('Synchronization failed: Rate limit exceeded');
      });

      it('rejects non-members', async () => {
        checkOrganizationMembership.mockResolvedValue(false);
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/sync-all-repos');
        await handlers['issue_comment.created'](context);

        expect(synchronizeAllRepositories).not.toHaveBeenCalled();
      });

      it('does not mark processed when deliveryId is absent', async () => {
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/sync-all-repos', { id: undefined });
        await handlers['issue_comment.created'](context);

        expect(markProcessed).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // /check-config
    // -----------------------------------------------------------------------
    describe('/check-config', () => {
      it('generates and posts a configuration report', async () => {
        generateConfigurationReport.mockResolvedValue('## Config Report\nAll good!');
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/check-config');
        await handlers['issue_comment.created'](context);

        expect(generateConfigurationReport).toHaveBeenCalledWith(context.octokit, 'myorg', 'myrepo');
        expect(context.octokit.issues.createComment).toHaveBeenCalledWith(
          expect.objectContaining({
            body: '## Config Report\nAll good!'
          })
        );
        expect(markProcessed).toHaveBeenCalledWith('delivery-2');
      });

      it('rejects non-members', async () => {
        checkOrganizationMembership.mockResolvedValue(false);
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/check-config');
        await handlers['issue_comment.created'](context);

        expect(generateConfigurationReport).not.toHaveBeenCalled();
      });

      it('does not mark processed when deliveryId is absent', async () => {
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/check-config', { id: undefined });
        await handlers['issue_comment.created'](context);

        expect(markProcessed).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // /check-dependabot
    // -----------------------------------------------------------------------
    describe('/check-dependabot', () => {
      it('generates and posts a dependabot report', async () => {
        checkDependabotConfiguration.mockResolvedValue('## Dependabot is configured');
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/check-dependabot');
        await handlers['issue_comment.created'](context);

        expect(checkDependabotConfiguration).toHaveBeenCalledWith(context.octokit, 'myorg', 'myrepo');
        expect(context.octokit.issues.createComment).toHaveBeenCalledWith(
          expect.objectContaining({
            body: '## Dependabot is configured'
          })
        );
        expect(markProcessed).toHaveBeenCalledWith('delivery-2');
      });

      it('rejects non-members', async () => {
        checkOrganizationMembership.mockResolvedValue(false);
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/check-dependabot');
        await handlers['issue_comment.created'](context);

        expect(checkDependabotConfiguration).not.toHaveBeenCalled();
      });

      it('does not mark processed when deliveryId is absent', async () => {
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/check-dependabot', { id: undefined });
        await handlers['issue_comment.created'](context);

        expect(markProcessed).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // /fix-dependabot-labels
    // -----------------------------------------------------------------------
    describe('/fix-dependabot-labels', () => {
      it('fixes labels when label issues exist', async () => {
        const mockLabelIssues = [
          { number: 10, missingLabels: ['dependencies'] },
          { number: 11, missingLabels: ['automation'] }
        ];
        checkExistingDependabotConfig.mockResolvedValue({ labelIssues: mockLabelIssues });
        fixDependabotPRLabels.mockResolvedValue({ success: true, fixedIssues: 2 });

        const { handlers } = setupApp();
        const context = createIssueCommentContext('/fix-dependabot-labels');
        await handlers['issue_comment.created'](context);

        expect(checkExistingDependabotConfig).toHaveBeenCalledWith(context.octokit, 'myorg', 'myrepo');
        expect(fixDependabotPRLabels).toHaveBeenCalledWith(
          context.octokit, 'myorg', 'myrepo', mockLabelIssues
        );
        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('Fixed labels on 2 Dependabot PRs');
        expect(markProcessed).toHaveBeenCalledWith('delivery-2');
      });

      it('posts no-issues message when no label issues found', async () => {
        checkExistingDependabotConfig.mockResolvedValue({ labelIssues: [] });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/fix-dependabot-labels');
        await handlers['issue_comment.created'](context);

        expect(fixDependabotPRLabels).not.toHaveBeenCalled();
        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('No Dependabot PR label issues found');
        expect(markProcessed).toHaveBeenCalledWith('delivery-2');
      });

      it('rejects non-members', async () => {
        checkOrganizationMembership.mockResolvedValue(false);
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/fix-dependabot-labels');
        await handlers['issue_comment.created'](context);

        expect(checkExistingDependabotConfig).not.toHaveBeenCalled();
      });

      it('does not mark processed when deliveryId is absent', async () => {
        checkExistingDependabotConfig.mockResolvedValue({ labelIssues: [] });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/fix-dependabot-labels', { id: undefined });
        await handlers['issue_comment.created'](context);

        expect(markProcessed).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // /generate-dependabot
    // -----------------------------------------------------------------------
    describe('/generate-dependabot', () => {
      it('generates and applies dependabot config', async () => {
        generateDependabotConfig.mockResolvedValue({
          config: { version: 2, updates: [{ 'package-ecosystem': 'npm', directory: '/' }] },
          ecosystems: [{ ecosystem: 'npm', directory: '/' }],
          report: 'Detected 1 ecosystem(s): npm (/)'
        });
        applyDependabotConfig.mockResolvedValue();

        const { handlers } = setupApp();
        const context = createIssueCommentContext('/generate-dependabot');
        context.octokit.request.mockResolvedValue({ data: { default_branch: 'main' } });
        await handlers['issue_comment.created'](context);

        expect(generateDependabotConfig).toHaveBeenCalledWith(context.octokit, 'myorg', 'myrepo', 'main');
        expect(applyDependabotConfig).toHaveBeenCalled();
        // Two comments: the config preview + the success message
        expect(context.octokit.issues.createComment).toHaveBeenCalledTimes(2);
      });

      it('posts message when no ecosystems detected', async () => {
        generateDependabotConfig.mockResolvedValue({
          config: null,
          ecosystems: [],
          report: 'No package ecosystems detected.'
        });

        const { handlers } = setupApp();
        const context = createIssueCommentContext('/generate-dependabot');
        context.octokit.request.mockResolvedValue({ data: { default_branch: 'main' } });
        await handlers['issue_comment.created'](context);

        expect(applyDependabotConfig).not.toHaveBeenCalled();
        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('No package ecosystems detected');
      });

      it('posts error message on failure', async () => {
        generateDependabotConfig.mockRejectedValue(new Error('API error'));

        const { handlers } = setupApp();
        const context = createIssueCommentContext('/generate-dependabot');
        context.octokit.request.mockResolvedValue({ data: { default_branch: 'main' } });
        await handlers['issue_comment.created'](context);

        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('Error generating Dependabot config');
      });

      it('rejects non-members', async () => {
        checkOrganizationMembership.mockResolvedValue(false);
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/generate-dependabot');
        await handlers['issue_comment.created'](context);

        expect(generateDependabotConfig).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // /analyze-org
    // -----------------------------------------------------------------------
    describe('/analyze-org', () => {
      it('creates an analysis report issue and posts a link comment', async () => {
        generateOrganizationAnalysisReport.mockResolvedValue('# Org Analysis');
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/analyze-org');
        context.octokit.issues.create.mockResolvedValue({ data: { number: 99 } });
        await handlers['issue_comment.created'](context);

        expect(generateOrganizationAnalysisReport).toHaveBeenCalledWith(context.octokit, 'myorg');
        expect(context.octokit.issues.create).toHaveBeenCalledWith(
          expect.objectContaining({
            owner: 'myorg',
            repo: 'myrepo',
            title: expect.stringContaining('Organization Analysis Report'),
            body: '# Org Analysis',
            labels: ['analysis', 'report', 'automation']
          })
        );
        expect(context.octokit.issues.createComment).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.stringContaining('#99')
          })
        );
        expect(markProcessed).toHaveBeenCalledWith('delivery-2');
      });

      it('uses config organization when set', async () => {
        _setConfigForTesting({ organization: 'config-org' });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/analyze-org');
        await handlers['issue_comment.created'](context);

        expect(generateOrganizationAnalysisReport).toHaveBeenCalledWith(context.octokit, 'config-org');
      });

      it('rejects non-members', async () => {
        checkOrganizationMembership.mockResolvedValue(false);
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/analyze-org');
        await handlers['issue_comment.created'](context);

        expect(generateOrganizationAnalysisReport).not.toHaveBeenCalled();
      });

      it('does not mark processed when deliveryId is absent', async () => {
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/analyze-org', { id: undefined });
        await handlers['issue_comment.created'](context);

        expect(markProcessed).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // /check-merge-strategy
    // -----------------------------------------------------------------------
    describe('/check-merge-strategy', () => {
      it('posts merge strategy analysis with no signed commits', async () => {
        checkPRMergeStrategy.mockResolvedValue({
          prTitle: 'Add feature',
          baseBranch: 'main',
          hasSignedCommits: false,
          currentMergeStrategy: { allowMergeCommit: false, allowSquashMerge: false, allowRebaseMerge: true },
          commitCount: 3,
          signedCommitCount: 0
        });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/check-merge-strategy');
        await handlers['issue_comment.created'](context);

        expect(checkPRMergeStrategy).toHaveBeenCalledWith(context.octokit, 'myorg', 'myrepo', 7);
        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('Merge Strategy Analysis for PR #7');
        expect(body).toContain('Add feature');
        expect(body).toContain('3 total, 0 signed');
        expect(body).toContain('No signed commits detected');
        expect(body).toContain('Current merge strategy is appropriate');
        expect(markProcessed).toHaveBeenCalledWith('delivery-2');
      });

      it('posts warning when signed commits are detected', async () => {
        checkPRMergeStrategy.mockResolvedValue({
          prTitle: 'Security fix',
          baseBranch: 'main',
          hasSignedCommits: true,
          currentMergeStrategy: { allowMergeCommit: false, allowSquashMerge: true, allowRebaseMerge: true },
          commitCount: 5,
          signedCommitCount: 3
        });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/check-merge-strategy');
        await handlers['issue_comment.created'](context);

        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('contains signed commits');
        expect(body).toContain('Use merge commit to preserve signatures');
        expect(body).toContain('/allow-merge-commit');
      });

      it('posts error when checkPRMergeStrategy returns error', async () => {
        checkPRMergeStrategy.mockResolvedValue({ error: 'PR not found' });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/check-merge-strategy');
        await handlers['issue_comment.created'](context);

        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('Error checking merge strategy: PR not found');
        expect(markProcessed).toHaveBeenCalledWith('delivery-2');
      });

      it('includes merge strategy settings in response', async () => {
        checkPRMergeStrategy.mockResolvedValue({
          prTitle: 'Test',
          baseBranch: 'develop',
          hasSignedCommits: false,
          currentMergeStrategy: { allowMergeCommit: true, allowSquashMerge: true, allowRebaseMerge: false },
          commitCount: 1,
          signedCommitCount: 0
        });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/check-merge-strategy');
        await handlers['issue_comment.created'](context);

        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('Current Repository Settings');
        expect(body).toContain('Allow Merge Commit:');
        expect(body).toContain('Allow Squash Merge:');
        expect(body).toContain('Allow Rebase Merge:');
      });

      it('rejects non-members', async () => {
        checkOrganizationMembership.mockResolvedValue(false);
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/check-merge-strategy');
        await handlers['issue_comment.created'](context);

        expect(checkPRMergeStrategy).not.toHaveBeenCalled();
      });

      it('does not mark processed when deliveryId is absent (no error)', async () => {
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/check-merge-strategy', { id: undefined });
        await handlers['issue_comment.created'](context);

        expect(markProcessed).not.toHaveBeenCalled();
      });

      it('does not mark processed when deliveryId is absent (error path)', async () => {
        checkPRMergeStrategy.mockResolvedValue({ error: 'timeout' });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/check-merge-strategy', { id: undefined });
        await handlers['issue_comment.created'](context);

        expect(markProcessed).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // /allow-merge-commit
    // -----------------------------------------------------------------------
    describe('/allow-merge-commit', () => {
      it('temporarily allows merge commits and posts success comment', async () => {
        _setConfigForTesting({ signed_commit_strategy: { admin_users: [] } });
        handleSignedCommitMerge.mockResolvedValue({
          success: true,
          action: 'temporarily_allowed_merge_commits',
          message: 'Merge commits temporarily allowed.'
        });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/allow-merge-commit');
        await handlers['issue_comment.created'](context);

        expect(handleSignedCommitMerge).toHaveBeenCalledWith(context.octokit, 'myorg', 'myrepo', 7);
        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('Merge commits temporarily allowed.');
        expect(body).toContain('merge commit strategy to preserve signed commits');
        expect(body).toContain('restore to rebase-only after 1 hour');
        expect(markProcessed).toHaveBeenCalledWith('delivery-2');
      });

      it('posts info comment for other successful actions', async () => {
        _setConfigForTesting({ signed_commit_strategy: {} });
        handleSignedCommitMerge.mockResolvedValue({
          success: true,
          action: 'no_change_needed',
          message: 'Already allows merge commits.'
        });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/allow-merge-commit');
        await handlers['issue_comment.created'](context);

        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('Already allows merge commits.');
        // Should not contain the "temporarily" message
        expect(body).not.toContain('restore to rebase-only');
      });

      it('posts error comment when handleSignedCommitMerge fails', async () => {
        _setConfigForTesting({ signed_commit_strategy: {} });
        handleSignedCommitMerge.mockResolvedValue({ success: false, error: 'API failure' });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/allow-merge-commit');
        await handlers['issue_comment.created'](context);

        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('Error: API failure');
      });

      it('rejects unauthorized admin users', async () => {
        _setConfigForTesting({ signed_commit_strategy: { admin_users: ['admin1', 'admin2'] } });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/allow-merge-commit', {
          sender: { login: 'regularuser' }
        });
        await handlers['issue_comment.created'](context);

        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('not authorized to run this command');
        expect(handleSignedCommitMerge).not.toHaveBeenCalled();
      });

      it('allows admin users from the config list', async () => {
        _setConfigForTesting({ signed_commit_strategy: { admin_users: ['admin1', 'someuser'] } });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/allow-merge-commit');
        await handlers['issue_comment.created'](context);

        expect(handleSignedCommitMerge).toHaveBeenCalled();
      });

      it('allows all users when admin_users list is empty', async () => {
        _setConfigForTesting({ signed_commit_strategy: { admin_users: [] } });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/allow-merge-commit');
        await handlers['issue_comment.created'](context);

        expect(handleSignedCommitMerge).toHaveBeenCalled();
      });

      it('allows all users when admin_users is not defined', async () => {
        _setConfigForTesting({ signed_commit_strategy: {} });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/allow-merge-commit');
        await handlers['issue_comment.created'](context);

        expect(handleSignedCommitMerge).toHaveBeenCalled();
      });

      it('rejects non-members before admin check', async () => {
        checkOrganizationMembership.mockResolvedValue(false);
        _setConfigForTesting({ signed_commit_strategy: { admin_users: ['someuser'] } });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/allow-merge-commit');
        await handlers['issue_comment.created'](context);

        expect(handleSignedCommitMerge).not.toHaveBeenCalled();
      });

      it('does not mark processed when deliveryId is absent', async () => {
        _setConfigForTesting({ signed_commit_strategy: {} });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/allow-merge-commit', { id: undefined });
        await handlers['issue_comment.created'](context);

        expect(markProcessed).not.toHaveBeenCalled();
      });
    });

    // -----------------------------------------------------------------------
    // /review-pr
    // -----------------------------------------------------------------------
    describe('/review-pr', () => {
      it('rejects when comment is not on a pull request', async () => {
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/review-pr', {
          issue: { number: 7, pull_request: undefined }
        });
        await handlers['issue_comment.created'](context);

        const body = context.octokit.issues.createComment.mock.calls[0][0].body;
        expect(body).toContain('can only be used on pull requests');
        expect(reviewPullRequest).not.toHaveBeenCalled();
      });

      it('posts working comment, reviews PR, and deletes working comment on success', async () => {
        reviewPullRequest.mockResolvedValue({ success: true });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/review-pr', {
          issue: { number: 7, pull_request: { url: 'https://api.github.com/pulls/7' } }
        });
        context.octokit.issues.createComment.mockResolvedValue({ data: { id: 555 } });
        await handlers['issue_comment.created'](context);

        // First createComment call is the "working on it" indicator
        expect(context.octokit.issues.createComment).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.stringContaining('AI review in progress')
          })
        );
        expect(reviewPullRequest).toHaveBeenCalledWith(context.octokit, 'myorg', 'myrepo', 7);
        expect(context.octokit.issues.deleteComment).toHaveBeenCalledWith(
          expect.objectContaining({ comment_id: 555 })
        );
        expect(markProcessed).toHaveBeenCalledWith('delivery-2');
      });

      it('updates working comment with error on failure', async () => {
        reviewPullRequest.mockResolvedValue({ success: false, error: 'AI service unavailable' });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/review-pr', {
          issue: { number: 7, pull_request: { url: 'https://api.github.com/pulls/7' } }
        });
        context.octokit.issues.createComment.mockResolvedValue({ data: { id: 777 } });
        await handlers['issue_comment.created'](context);

        expect(context.octokit.issues.updateComment).toHaveBeenCalledWith(
          expect.objectContaining({
            comment_id: 777,
            body: expect.stringContaining('AI review failed: AI service unavailable')
          })
        );
        expect(context.octokit.issues.deleteComment).not.toHaveBeenCalled();
      });

      it('rejects non-members', async () => {
        checkOrganizationMembership.mockResolvedValue(false);
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/review-pr', {
          issue: { number: 7, pull_request: { url: 'https://api.github.com/pulls/7' } }
        });
        await handlers['issue_comment.created'](context);

        expect(reviewPullRequest).not.toHaveBeenCalled();
      });

      it('does not mark processed when deliveryId is absent', async () => {
        reviewPullRequest.mockResolvedValue({ success: true });
        const { handlers } = setupApp();
        const context = createIssueCommentContext('/review-pr', {
          id: undefined,
          issue: { number: 7, pull_request: { url: 'https://api.github.com/pulls/7' } }
        });
        context.octokit.issues.createComment.mockResolvedValue({ data: { id: 888 } });
        await handlers['issue_comment.created'](context);

        expect(markProcessed).not.toHaveBeenCalled();
      });
    });
  });
});
