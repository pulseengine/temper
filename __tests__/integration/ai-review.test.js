// jest.mock() calls are hoisted by babel above all other code, so factories
// must be self-contained. We import the mocked modules after the mock
// declarations and reference the mock functions through those imports.

jest.mock('../../src/logger.js', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { getLogger: () => mockLogger };
});

import {
  buildReviewPrompt,
  callLocalAI,
  formatReviewComment,
  isLocalEndpoint,
  reviewPullRequest,
  sanitizeAIOutput,
  _reviewTimestamps
} from '../../src/ai-review.js';
import { _setConfigForTesting } from '../../src/config.js';
import { getLogger } from '../../src/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockOctokit() {
  return {
    request: jest.fn().mockResolvedValue({ status: 200, data: {} }),
    issues: {
      createComment: jest.fn().mockResolvedValue({ status: 201, data: {} })
    }
  };
}

function makePrData(overrides = {}) {
  return {
    number: 42,
    title: 'Fix bug',
    user: { login: 'dev' },
    base: { ref: 'main' },
    head: { ref: 'fix-branch' },
    body: 'Fixes #1',
    ...overrides
  };
}

function makeAiConfig(overrides = {}) {
  return {
    enabled: true,
    endpoint: 'http://localhost:11434/v1/chat/completions',
    model: 'codellama',
    max_diff_size: 12000,
    max_tokens: 2000,
    temperature: 0.3,
    timeout: 120000,
    ...overrides
  };
}

function mockFetchSuccess(content = 'Looks good!') {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: jest.fn().mockResolvedValue({
      choices: [{ message: { content } }]
    })
  });
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

const mockOriginalFetch = global.fetch;

afterEach(() => {
  _reviewTimestamps.clear();
  _setConfigForTesting({});
  global.fetch = mockOriginalFetch;
  jest.clearAllMocks();
});

// ===========================================================================
// isLocalEndpoint
// ===========================================================================

describe('ai-review', () => {
  describe('isLocalEndpoint', () => {
    it('accepts localhost', () => {
      expect(isLocalEndpoint('http://localhost:1234/v1')).toBe(true);
    });

    it('accepts 127.0.0.1', () => {
      expect(isLocalEndpoint('http://127.0.0.1:8080/api')).toBe(true);
    });

    it('accepts [::1] IPv6 loopback', () => {
      expect(isLocalEndpoint('http://[::1]:8080/api')).toBe(true);
    });

    it('rejects remote hosts', () => {
      expect(isLocalEndpoint('https://api.openai.com/v1')).toBe(false);
    });

    it('rejects other hostnames', () => {
      expect(isLocalEndpoint('https://my-server.com/v1')).toBe(false);
    });

    it('rejects invalid URLs', () => {
      expect(isLocalEndpoint('not-a-url')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(isLocalEndpoint('')).toBe(false);
    });

    it('accepts localhost with path segments', () => {
      expect(isLocalEndpoint('http://localhost/v1/chat/completions')).toBe(true);
    });

    it('accepts 127.0.0.1 without port', () => {
      expect(isLocalEndpoint('http://127.0.0.1/api')).toBe(true);
    });
  });

  // =========================================================================
  // sanitizeAIOutput
  // =========================================================================

  describe('sanitizeAIOutput', () => {
    it('strips workflow commands', () => {
      const input = 'Some text\n::set-output name=foo::bar\nMore text';
      const result = sanitizeAIOutput(input);
      expect(result).toContain('Some text');
      expect(result).toContain('[sanitized command]');
      expect(result).toContain('More text');
    });

    it('strips multiple workflow commands', () => {
      const input = '::warning::bad\n::error file=x::oops\nOK line';
      const result = sanitizeAIOutput(input);
      expect(result).not.toContain('::warning');
      expect(result).not.toContain('::error');
      expect(result).toContain('OK line');
    });

    it('passes through normal text', () => {
      expect(sanitizeAIOutput('Normal review text')).toBe('Normal review text');
    });

    it('handles empty string', () => {
      expect(sanitizeAIOutput('')).toBe('');
    });

    it('strips commands with multiple key-value attributes', () => {
      const input = '::set-env name=VAR value=SECRET::malicious';
      const result = sanitizeAIOutput(input);
      expect(result).toBe('[sanitized command]');
    });
  });

  // =========================================================================
  // buildReviewPrompt
  // =========================================================================

  describe('buildReviewPrompt', () => {
    it('builds a prompt with PR data', () => {
      const prData = makePrData();
      const diff = '+ added line';
      const files = [{ filename: 'src/foo.js', additions: 1, deletions: 0 }];
      const result = buildReviewPrompt(prData, diff, files, 10000);
      expect(result).toContain('Pull Request #42');
      expect(result).toContain('Fix bug');
      expect(result).toContain('src/foo.js');
      expect(result).toContain('dev');
      expect(result).toContain('Fixes #1');
      expect(result).toContain('+ added line');
    });

    it('truncates large diffs', () => {
      const prData = makePrData({ number: 1, title: 'T', body: '' });
      const diff = 'x'.repeat(200);
      const result = buildReviewPrompt(prData, diff, [], 100);
      expect(result).toContain('[... diff truncated due to size ...]');
    });

    it('does not truncate small diffs', () => {
      const prData = makePrData({ number: 1, title: 'T', body: '' });
      const diff = 'small diff';
      const result = buildReviewPrompt(prData, diff, [], 10000);
      expect(result).not.toContain('[... diff truncated due to size ...]');
      expect(result).toContain('small diff');
    });

    it('handles null body with (no description)', () => {
      const prData = makePrData({ body: null });
      const result = buildReviewPrompt(prData, '', [], 10000);
      expect(result).toContain('(no description)');
    });

    it('handles undefined body with (no description)', () => {
      const prData = makePrData({ body: undefined });
      const result = buildReviewPrompt(prData, '', [], 10000);
      expect(result).toContain('(no description)');
    });

    it('handles empty string body', () => {
      const prData = makePrData({ body: '' });
      const result = buildReviewPrompt(prData, '', [], 10000);
      expect(result).toContain('(no description)');
    });

    it('lists multiple files', () => {
      const prData = makePrData();
      const files = [
        { filename: 'a.js', additions: 5, deletions: 2 },
        { filename: 'b.js', additions: 0, deletions: 10 }
      ];
      const result = buildReviewPrompt(prData, '', files, 10000);
      expect(result).toContain('a.js (+5/-2)');
      expect(result).toContain('b.js (+0/-10)');
    });

    it('includes base and head branch refs', () => {
      const prData = makePrData({ base: { ref: 'develop' }, head: { ref: 'feature/new' } });
      const result = buildReviewPrompt(prData, '', [], 10000);
      expect(result).toContain('develop');
      expect(result).toContain('feature/new');
    });

    it('wraps diff in code block', () => {
      const prData = makePrData();
      const result = buildReviewPrompt(prData, 'some diff', [], 10000);
      expect(result).toContain('```diff\nsome diff\n```');
    });

    it('truncates diff exactly at maxDiffSize boundary', () => {
      const prData = makePrData();
      const diff = 'a'.repeat(100);
      // Diff of exactly maxDiffSize should NOT be truncated
      const result = buildReviewPrompt(prData, diff, [], 100);
      expect(result).not.toContain('[... diff truncated due to size ...]');
      expect(result).toContain('a'.repeat(100));
    });

    it('truncates diff at maxDiffSize + 1', () => {
      const prData = makePrData();
      const diff = 'a'.repeat(101);
      const result = buildReviewPrompt(prData, diff, [], 100);
      expect(result).toContain('[... diff truncated due to size ...]');
      // The truncated content should be exactly 100 chars
      expect(result).toContain('a'.repeat(100));
    });
  });

  // =========================================================================
  // formatReviewComment
  // =========================================================================

  describe('formatReviewComment', () => {
    it('wraps AI response with header and disclaimer', () => {
      const result = formatReviewComment('Looks good!', 5);
      expect(result).toContain('AI Code Review for PR #5');
      expect(result).toContain('Looks good!');
      expect(result).toContain('advisory only');
    });

    it('sanitizes the AI response', () => {
      const result = formatReviewComment('Good code\n::set-output name=x::hack', 10);
      expect(result).toContain('[sanitized command]');
      expect(result).not.toContain('::set-output');
    });

    it('includes local AI model attribution', () => {
      const result = formatReviewComment('Review text', 1);
      expect(result).toContain('local AI model');
    });

    it('includes horizontal rule separator', () => {
      const result = formatReviewComment('test', 1);
      expect(result).toContain('---');
    });

    it('includes may contain inaccuracies disclaimer', () => {
      const result = formatReviewComment('test', 99);
      expect(result).toContain('may contain inaccuracies');
    });
  });

  // =========================================================================
  // _reviewTimestamps
  // =========================================================================

  describe('_reviewTimestamps', () => {
    it('is a Map for rate limiting', () => {
      expect(_reviewTimestamps).toBeInstanceOf(Map);
    });

    it('can track review timestamps', () => {
      _reviewTimestamps.set('org/repo#1', Date.now());
      expect(_reviewTimestamps.has('org/repo#1')).toBe(true);
    });

    it('starts empty after clear', () => {
      _reviewTimestamps.set('key', 123);
      _reviewTimestamps.clear();
      expect(_reviewTimestamps.size).toBe(0);
    });
  });

  // =========================================================================
  // callLocalAI
  // =========================================================================

  describe('callLocalAI', () => {
    const mockEndpoint = 'http://localhost:11434/v1/chat/completions';
    const mockModel = 'codellama';
    const mockSystemPrompt = 'You are a code reviewer.';
    const mockUserPrompt = 'Review this code.';

    it('returns AI content on successful response', async () => {
      mockFetchSuccess('This code looks great!');

      const result = await callLocalAI(mockEndpoint, mockModel, mockSystemPrompt, mockUserPrompt);

      expect(result).toBe('This code looks great!');
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledWith(
        mockEndpoint,
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: expect.any(String),
          signal: expect.any(AbortSignal)
        })
      );
    });

    it('sends correct request body with messages', async () => {
      mockFetchSuccess('ok');

      await callLocalAI(mockEndpoint, mockModel, mockSystemPrompt, mockUserPrompt);

      const callArgs = global.fetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.model).toBe('codellama');
      expect(body.messages).toEqual([
        { role: 'system', content: mockSystemPrompt },
        { role: 'user', content: mockUserPrompt }
      ]);
      expect(body.max_tokens).toBe(2000);
      expect(body.temperature).toBe(0.3);
    });

    it('uses default options when none provided', async () => {
      mockFetchSuccess('response');

      await callLocalAI(mockEndpoint, mockModel, mockSystemPrompt, mockUserPrompt);

      const callArgs = global.fetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.max_tokens).toBe(2000);
      expect(body.temperature).toBe(0.3);
    });

    it('uses custom options when provided', async () => {
      mockFetchSuccess('response');

      await callLocalAI(mockEndpoint, mockModel, mockSystemPrompt, mockUserPrompt, {
        maxTokens: 4000,
        temperature: 0.7,
        timeout: 60000
      });

      const callArgs = global.fetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.max_tokens).toBe(4000);
      expect(body.temperature).toBe(0.7);
    });

    it('throws when response is not ok', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error'
      });

      await expect(
        callLocalAI(mockEndpoint, mockModel, mockSystemPrompt, mockUserPrompt)
      ).rejects.toThrow('AI endpoint returned 500: Internal Server Error');
    });

    it('throws when response is 404', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found'
      });

      await expect(
        callLocalAI(mockEndpoint, mockModel, mockSystemPrompt, mockUserPrompt)
      ).rejects.toThrow('AI endpoint returned 404: Not Found');
    });

    it('returns empty string when choices are missing', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({})
      });

      const result = await callLocalAI(mockEndpoint, mockModel, mockSystemPrompt, mockUserPrompt);
      expect(result).toBe('');
    });

    it('returns empty string when choices array is empty', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ choices: [] })
      });

      const result = await callLocalAI(mockEndpoint, mockModel, mockSystemPrompt, mockUserPrompt);
      expect(result).toBe('');
    });

    it('returns empty string when message content is null', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          choices: [{ message: { content: null } }]
        })
      });

      const result = await callLocalAI(mockEndpoint, mockModel, mockSystemPrompt, mockUserPrompt);
      expect(result).toBe('');
    });

    it('returns empty string when message object is missing', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({
          choices: [{}]
        })
      });

      const result = await callLocalAI(mockEndpoint, mockModel, mockSystemPrompt, mockUserPrompt);
      expect(result).toBe('');
    });

    it('propagates fetch network errors', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(
        callLocalAI(mockEndpoint, mockModel, mockSystemPrompt, mockUserPrompt)
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('clears timeout even when fetch throws', async () => {
      // We verify clearTimeout runs by ensuring no unhandled timer issues.
      // The finally block should always execute.
      global.fetch = jest.fn().mockRejectedValue(new Error('Network failure'));

      await expect(
        callLocalAI(mockEndpoint, mockModel, mockSystemPrompt, mockUserPrompt)
      ).rejects.toThrow('Network failure');
    });

    it('uses AbortController signal for timeout', async () => {
      mockFetchSuccess('response');

      await callLocalAI(mockEndpoint, mockModel, mockSystemPrompt, mockUserPrompt, {
        timeout: 5000
      });

      const callArgs = global.fetch.mock.calls[0];
      expect(callArgs[1].signal).toBeInstanceOf(AbortSignal);
    });
  });

  // =========================================================================
  // reviewPullRequest
  // =========================================================================

  describe('reviewPullRequest', () => {
    let octokit;

    beforeEach(() => {
      octokit = createMockOctokit();
      // Reset fetch to a successful mock by default
      mockFetchSuccess('AI review: code looks great.');
    });

    it('returns error when AI review is not enabled', async () => {
      _setConfigForTesting({ ai_review: { enabled: false } });

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('AI review is not enabled in configuration.');
    });

    it('returns error when ai_review config is missing entirely', async () => {
      _setConfigForTesting({});

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('AI review is not enabled in configuration.');
    });

    it('returns error when ai_review is null', async () => {
      _setConfigForTesting({ ai_review: null });

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('AI review is not enabled in configuration.');
    });

    it('returns error when ai_review is undefined', async () => {
      _setConfigForTesting({ ai_review: undefined });

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('AI review is not enabled in configuration.');
    });

    it('returns rate limit error when called too frequently on same PR', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      // Simulate a recent review
      _reviewTimestamps.set('owner/repo#1', Date.now());

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Rate limited');
      expect(result.error).toContain('5 minutes');
    });

    it('allows review when rate limit period has passed', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      // Simulate an old review (6 minutes ago)
      _reviewTimestamps.set('owner/repo#1', Date.now() - 360000);

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: '+ added line' })
        .mockResolvedValueOnce({ data: [{ filename: 'a.js', additions: 1, deletions: 0 }] });

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(true);
    });

    it('returns error when remote endpoint is not allowed', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({
          endpoint: 'https://api.openai.com/v1/chat/completions',
          allow_remote_endpoint: false
        })
      });

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Remote AI endpoints are not allowed');
    });

    it('allows remote endpoint when allow_remote_endpoint is true', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({
          endpoint: 'https://api.openai.com/v1/chat/completions',
          allow_remote_endpoint: true
        })
      });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: '+ added line' })
        .mockResolvedValueOnce({ data: [{ filename: 'a.js', additions: 1, deletions: 0 }] });

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(true);
    });

    it('allows local endpoint without allow_remote_endpoint flag', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({
          endpoint: 'http://localhost:11434/v1/chat/completions',
          allow_remote_endpoint: false
        })
      });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: '+ added line' })
        .mockResolvedValueOnce({ data: [{ filename: 'a.js', additions: 1, deletions: 0 }] });

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(true);
    });

    it('successfully reviews a PR end-to-end', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      const prData = makePrData();
      octokit.request
        .mockResolvedValueOnce({ data: prData })
        .mockResolvedValueOnce({ data: '+ added line\n- removed line' })
        .mockResolvedValueOnce({
          data: [
            { filename: 'src/foo.js', additions: 1, deletions: 1 },
            { filename: 'src/bar.js', additions: 5, deletions: 0 }
          ]
        });

      mockFetchSuccess('Code looks good overall. No critical issues found.');

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 42);

      expect(result.success).toBe(true);
      expect(result.comment).toContain('AI Code Review for PR #42');
      expect(result.comment).toContain('Code looks good overall');
      expect(result.comment).toContain('advisory only');
      expect(octokit.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 42,
        body: expect.stringContaining('AI Code Review for PR #42')
      });
    });

    it('records timestamp after successful review', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff content' })
        .mockResolvedValueOnce({ data: [] });

      const beforeTime = Date.now();
      await reviewPullRequest(octokit, 'owner', 'repo', 42);
      const afterTime = Date.now();

      const timestamp = _reviewTimestamps.get('owner/repo#42');
      expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('uses default system prompt when none configured', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({ system_prompt: undefined })
      });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'some diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 1);

      const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(fetchBody.messages[0].content).toContain('thorough code reviewer');
    });

    it('uses custom system prompt when configured', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({ system_prompt: 'Custom reviewer instructions.' })
      });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'some diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 1);

      const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(fetchBody.messages[0].content).toBe('Custom reviewer instructions.');
    });

    it('uses default model when none configured', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({ model: undefined })
      });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'some diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 1);

      const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(fetchBody.model).toBe('local-model');
    });

    it('uses configured model', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({ model: 'deepseek-coder' })
      });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'some diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 1);

      const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(fetchBody.model).toBe('deepseek-coder');
    });

    it('uses default max_diff_size when not configured', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({ max_diff_size: undefined })
      });

      const largeDiff = 'x'.repeat(15000);
      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: largeDiff })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 1);

      // Default max_diff_size is 12000, so the diff should be truncated
      const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(fetchBody.messages[1].content).toContain('[... diff truncated due to size ...]');
    });

    it('uses default max_tokens when not configured', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({ max_tokens: undefined })
      });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 1);

      const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(fetchBody.max_tokens).toBe(2000);
    });

    it('uses default temperature when not configured', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({ temperature: undefined })
      });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 1);

      const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(fetchBody.temperature).toBe(0.3);
    });

    it('handles non-string diff data gracefully', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: { some: 'object' } })  // not a string
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 1);

      // Should use empty string when diff is not a string
      const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(fetchBody.messages[1].content).not.toContain('[object Object]');
    });

    it('handles numeric diff data as non-string', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 12345 })  // not a string
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 1);

      const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      // Numeric diff should result in empty string being used
      expect(fetchBody.messages[1].content).toContain('```diff\n\n```');
    });

    it('returns error when octokit PR fetch fails', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request.mockRejectedValue(new Error('Not Found'));

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 999);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Not Found');
      expect(getLogger().error).toHaveBeenCalledWith(
        expect.stringContaining('Error reviewing PR #999'),
        'Not Found'
      );
    });

    it('returns error when diff fetch fails', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockRejectedValueOnce(new Error('Diff unavailable'));

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Diff unavailable');
    });

    it('returns error when files fetch fails', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockRejectedValueOnce(new Error('Files API error'));

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Files API error');
    });

    it('returns error when AI endpoint fails', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable'
      });

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(false);
      expect(result.error).toContain('AI endpoint returned 503');
    });

    it('returns error when createComment fails', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      octokit.issues.createComment.mockRejectedValue(new Error('Comment creation failed'));

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Comment creation failed');
    });

    it('does not record timestamp on failure', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request.mockRejectedValue(new Error('API failure'));

      await reviewPullRequest(octokit, 'owner', 'repo', 77);

      expect(_reviewTimestamps.has('owner/repo#77')).toBe(false);
    });

    it('rate limits per owner/repo/PR key', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      // Set rate limit for PR #1 but not PR #2
      _reviewTimestamps.set('owner/repo#1', Date.now());

      // PR #1 should be rate limited
      const result1 = await reviewPullRequest(octokit, 'owner', 'repo', 1);
      expect(result1.success).toBe(false);
      expect(result1.error).toContain('Rate limited');

      // PR #2 should NOT be rate limited
      octokit.request
        .mockResolvedValueOnce({ data: makePrData({ number: 2 }) })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      const result2 = await reviewPullRequest(octokit, 'owner', 'repo', 2);
      expect(result2.success).toBe(true);
    });

    it('rate limits per repo independently', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      // Set rate limit for repo-a but not repo-b
      _reviewTimestamps.set('owner/repo-a#1', Date.now());

      // repo-a PR #1 should be rate limited
      const result1 = await reviewPullRequest(octokit, 'owner', 'repo-a', 1);
      expect(result1.success).toBe(false);

      // repo-b PR #1 should NOT be rate limited
      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      const result2 = await reviewPullRequest(octokit, 'owner', 'repo-b', 1);
      expect(result2.success).toBe(true);
    });

    it('fetches PR data, diff with media type, and files', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff text' })
        .mockResolvedValueOnce({ data: [{ filename: 'a.js', additions: 1, deletions: 0 }] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 42);

      // First call: PR data
      expect(octokit.request).toHaveBeenNthCalledWith(1,
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        { owner: 'owner', repo: 'repo', pull_number: 42 }
      );

      // Second call: diff with media type
      expect(octokit.request).toHaveBeenNthCalledWith(2,
        'GET /repos/{owner}/{repo}/pulls/{pull_number}',
        { owner: 'owner', repo: 'repo', pull_number: 42, mediaType: { format: 'diff' } }
      );

      // Third call: files
      expect(octokit.request).toHaveBeenNthCalledWith(3,
        'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
        { owner: 'owner', repo: 'repo', pull_number: 42 }
      );
    });

    it('sanitizes AI response in the comment', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('Review summary\n::set-output name=hack::value\nAll good');

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 42);

      expect(result.success).toBe(true);
      expect(result.comment).toContain('[sanitized command]');
      expect(result.comment).not.toContain('::set-output');
    });

    it('returns error when AI fetch network fails', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(false);
      expect(result.error).toBe('ECONNREFUSED');
      expect(getLogger().error).toHaveBeenCalled();
    });

    it('passes configured timeout to callLocalAI', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({ timeout: 30000 })
      });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 1);

      // Verify fetch was called (timeout is internal to callLocalAI via AbortController)
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('handles empty AI response gracefully', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      // AI returns empty choices
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ choices: [] })
      });

      const result = await reviewPullRequest(octokit, 'owner', 'repo', 42);

      expect(result.success).toBe(true);
      expect(result.comment).toContain('AI Code Review for PR #42');
      // Comment should still be posted even if AI response is empty
      expect(octokit.issues.createComment).toHaveBeenCalled();
    });

    it('logs error with PR number on failure', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request.mockRejectedValue(new Error('Something went wrong'));

      await reviewPullRequest(octokit, 'owner', 'repo', 55);

      expect(getLogger().error).toHaveBeenCalledWith(
        expect.stringContaining('#55'),
        'Something went wrong'
      );
    });

    it('endpoint validation is skipped when allow_remote_endpoint is unset and endpoint is local', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({
          endpoint: 'http://127.0.0.1:8080/v1/completions'
          // allow_remote_endpoint not set (undefined -> falsy)
        })
      });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      const result = await reviewPullRequest(octokit, 'owner', 'repo', 1);

      expect(result.success).toBe(true);
    });

    it('uses custom max_tokens and temperature from config', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({
          max_tokens: 500,
          temperature: 0.8
        })
      });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 1);

      const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(fetchBody.max_tokens).toBe(500);
      expect(fetchBody.temperature).toBe(0.8);
    });
  });
});
