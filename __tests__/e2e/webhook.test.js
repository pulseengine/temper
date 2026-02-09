/**
 * E2E webhook simulation tests: boot the real Probot server as a subprocess,
 * send simulated GitHub webhook payloads via HTTP POST, and verify the server
 * processes them correctly.
 *
 * The server will attempt to call the GitHub API when processing valid events,
 * which will fail since we are not connected to a real GitHub App. This is
 * expected — the tests verify that webhook reception and signature validation
 * work correctly at the HTTP transport layer.
 */

import http from 'http';
import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const TEST_PRIVATE_KEY = fs.readFileSync(
  path.resolve('__tests__', 'fixtures', 'test-private-key.pem'),
  'utf8'
);

const WEBHOOK_SECRET = 'test-webhook-secret';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    }).on('error', reject);
  });
}

function waitForServer(url, maxAttempts = 50, interval = 300) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts++;
      httpGet(url)
        .then(resolve)
        .catch(() => {
          if (attempts >= maxAttempts) {
            reject(new Error(`Server not ready after ${maxAttempts} attempts`));
          } else {
            setTimeout(check, interval);
          }
        });
    };
    check();
  });
}

/**
 * Send a simulated GitHub webhook to the running Probot server.
 *
 * @param {string}  baseUrl  – e.g. "http://localhost:31234"
 * @param {string}  event    – GitHub event name (x-github-event header)
 * @param {object}  payload  – webhook payload (will be JSON-stringified)
 * @param {string}  secret   – HMAC secret used for signing
 * @returns {Promise<{status: number, body: string}>}
 */
function sendWebhook(baseUrl, event, payload, secret = WEBHOOK_SECRET) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const signature =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(body).digest('hex');

    const url = new URL(baseUrl);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: '/api/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': crypto.randomUUID(),
        'x-hub-signature-256': signature,
        'content-length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Send a raw string body (not necessarily valid JSON) as a webhook request.
 * The signature is computed over whatever rawBody is provided.
 */
function sendRawWebhook(baseUrl, event, rawBody, secret = WEBHOOK_SECRET) {
  return new Promise((resolve, reject) => {
    const signature =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    const url = new URL(baseUrl);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: '/api/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': crypto.randomUUID(),
        'x-hub-signature-256': signature,
        'content-length': Buffer.byteLength(rawBody),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

/**
 * Send a webhook payload without the x-hub-signature-256 header.
 */
function sendWebhookWithoutSignature(baseUrl, event, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const url = new URL(baseUrl);
    const options = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: '/api/github/webhooks',
      headers: {
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': crypto.randomUUID(),
        'content-length': Buffer.byteLength(body),
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

const repoCreatedPayload = {
  action: 'created',
  repository: {
    id: 123456,
    name: 'test-repo',
    full_name: 'test-org/test-repo',
    owner: { login: 'test-org' },
    default_branch: 'main',
    fork: false,
    has_issues: true,
  },
  organization: { login: 'test-org' },
  sender: { login: 'test-user' },
};

const issueCommentPayload = {
  action: 'created',
  issue: {
    number: 42,
    title: 'Test issue',
    pull_request: null,
  },
  comment: {
    id: 789,
    body: '/configure-repo',
    user: { login: 'test-user' },
  },
  repository: {
    id: 123456,
    name: 'test-repo',
    full_name: 'test-org/test-repo',
    owner: { login: 'test-org' },
    default_branch: 'main',
    fork: false,
  },
  organization: { login: 'test-org' },
  sender: { login: 'test-user' },
};

const starCreatedPayload = {
  action: 'created',
  starred_at: '2024-01-01T00:00:00Z',
  repository: {
    id: 123456,
    name: 'test-repo',
    full_name: 'test-org/test-repo',
    owner: { login: 'test-org' },
  },
  sender: { login: 'test-user' },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('E2E webhook simulation', () => {
  let serverProcess;
  let port;
  let baseUrl;
  let stdoutData = '';
  let stderrData = '';

  beforeAll(async () => {
    port = 30000 + Math.floor(Math.random() * 10000);
    baseUrl = `http://localhost:${port}`;

    serverProcess = spawn('node', ['index.js'], {
      env: {
        ...process.env,
        APP_ID: '12345',
        PRIVATE_KEY: TEST_PRIVATE_KEY,
        WEBHOOK_SECRET: WEBHOOK_SECRET,
        PORT: String(port),
        NODE_ENV: 'test',
        LOG_LEVEL: 'silent',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    serverProcess.stdout.on('data', (data) => { stdoutData += data.toString(); });
    serverProcess.stderr.on('data', (data) => { stderrData += data.toString(); });

    // Wait for the server to accept connections
    await waitForServer(baseUrl);
  }, 30000);

  afterAll(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGTERM');
    }
  });

  // -----------------------------------------------------------------------
  // 1. Invalid signature rejected
  // -----------------------------------------------------------------------
  it('rejects a webhook with an invalid signature', async () => {
    const res = await sendWebhook(
      baseUrl,
      'repository',
      repoCreatedPayload,
      'wrong-secret'
    );

    // Probot returns 400 or 401 for bad signatures
    expect([400, 401, 403]).toContain(res.status);
  });

  // -----------------------------------------------------------------------
  // 2. Missing signature rejected
  // -----------------------------------------------------------------------
  it('rejects a webhook with no signature header', async () => {
    const res = await sendWebhookWithoutSignature(
      baseUrl,
      'repository',
      repoCreatedPayload
    );

    expect([400, 401, 403]).toContain(res.status);
  });

  // -----------------------------------------------------------------------
  // 3. Valid repository.created event accepted
  // -----------------------------------------------------------------------
  it('accepts a properly signed repository.created event', async () => {
    const res = await sendWebhook(
      baseUrl,
      'repository',
      repoCreatedPayload
    );

    // The webhook should be accepted at the HTTP layer. Probot returns 200
    // or 202 for successfully received webhooks. The handler may fail
    // internally when trying to call the GitHub API, but the HTTP response
    // should indicate acceptance.
    expect([200, 202]).toContain(res.status);
  });

  // -----------------------------------------------------------------------
  // 4. Valid issue_comment.created event accepted
  // -----------------------------------------------------------------------
  it('accepts a properly signed issue_comment.created event', async () => {
    const res = await sendWebhook(
      baseUrl,
      'issue_comment',
      issueCommentPayload
    );

    // The webhook signature is valid so Probot accepts it. The handler will
    // attempt GitHub API calls (e.g. checking org membership) which fail
    // without a real connection, so Probot may return 500 from the handler
    // error. 200/202 (accepted) and 500 (handler error) all confirm the
    // signature was validated and the event was dispatched to the handler.
    expect([200, 202, 500]).toContain(res.status);
  }, 15000);

  // -----------------------------------------------------------------------
  // 5. Unknown event type handled gracefully
  // -----------------------------------------------------------------------
  it('handles an unsubscribed event type gracefully', async () => {
    const res = await sendWebhook(
      baseUrl,
      'star',
      starCreatedPayload
    );

    // Probot should still accept the webhook (signature is valid) even if
    // there is no handler registered for this event. It returns 200 or 202.
    expect([200, 202]).toContain(res.status);
  });

  // -----------------------------------------------------------------------
  // 6. Malformed JSON body rejected
  // -----------------------------------------------------------------------
  it('rejects a request with malformed JSON body', async () => {
    const malformedBody = '{"action": "created", broken json!!!';

    const res = await sendRawWebhook(
      baseUrl,
      'repository',
      malformedBody
    );

    // Probot / Express should reject unparseable JSON with 400
    expect([400, 422]).toContain(res.status);
  });

  // -----------------------------------------------------------------------
  // Bonus: server is still running after all tests
  // -----------------------------------------------------------------------
  it('server process is still alive after processing webhooks', () => {
    expect(serverProcess.exitCode).toBeNull();
  });
});
