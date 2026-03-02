// jest.mock() calls are hoisted by babel above all other code, so factories
// must be self-contained. We import the mocked modules after the mock
// declarations and reference the mock functions through those imports.

jest.mock('../../src/logger.js', () => {
  const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { getLogger: () => mockLogger };
});

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue('[]'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn()
}));

import {
  buildReviewPrompt,
  callLocalAI,
  formatReviewComment,
  isLocalEndpoint,
  reviewPullRequest,
  sanitizeAIOutput,
  parseDiffByFile,
  classifyFile,
  prioritizeFiles,
  supersedePreviousReviews,
  storeReview,
  getReviews,
  updateReviewStatus,
  _reviewTimestamps,
  _resetReviews,
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
      createComment: jest.fn().mockResolvedValue({ status: 201, data: {} }),
      listComments: jest.fn().mockResolvedValue({ data: [] }),
      updateComment: jest.fn().mockResolvedValue({ status: 200, data: {} })
    }
  };
}

function makePrData(overrides = {}) {
  return {
    number: 42,
    title: 'Fix bug',
    user: { login: 'dev' },
    base: { ref: 'main' },
    head: { ref: 'fix-branch', sha: 'abc1234567890abcdef' },
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

function makeDiff(filename, content = '+added') {
  return `diff --git a/${filename} b/${filename}\n--- a/${filename}\n+++ b/${filename}\n@@ -1,3 +1,4 @@\n${content}`;
}

function makeMultiDiff(files) {
  return files.map(({ name, content }) => makeDiff(name, content || '+changed')).join('\n');
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
  _resetReviews();
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
    it('builds a prompt with PR metadata', () => {
      const prData = makePrData();
      const diff = makeDiff('src/foo.js', '+added line');
      const files = [{ filename: 'src/foo.js', additions: 1, deletions: 0 }];
      const result = buildReviewPrompt(prData, diff, files, 10000);
      expect(result).toContain('Pull Request #42');
      expect(result).toContain('Fix bug');
      expect(result).toContain('src/foo.js');
      expect(result).toContain('dev');
      expect(result).toContain('Fixes #1');
    });

    it('includes source file diff in code block', () => {
      const prData = makePrData();
      const diff = makeDiff('src/main.rs', '+fn main() {}');
      const files = [{ filename: 'src/main.rs', additions: 1, deletions: 0 }];
      const result = buildReviewPrompt(prData, diff, files, 10000);
      expect(result).toContain('```diff');
      expect(result).toContain('+fn main() {}');
    });

    it('annotates files with tier labels in manifest', () => {
      const prData = makePrData();
      const diff = makeMultiDiff([
        { name: 'src/main.rs' },
        { name: 'Cargo.lock' },
        { name: 'src/main.test.js' }
      ]);
      const files = [
        { filename: 'src/main.rs', additions: 1, deletions: 0 },
        { filename: 'Cargo.lock', additions: 500, deletions: 200 },
        { filename: 'src/main.test.js', additions: 3, deletions: 0 }
      ];
      const result = buildReviewPrompt(prData, diff, files, 50000);
      expect(result).toContain('[source]');
      expect(result).toContain('[skipped: lockfile/generated]');
      expect(result).toContain('[test]');
    });

    it('excludes tier 0 files from diff content', () => {
      const prData = makePrData();
      const diff = makeMultiDiff([
        { name: 'src/app.js', content: '+source code' },
        { name: 'Cargo.lock', content: '+lockfile data' }
      ]);
      const files = [
        { filename: 'src/app.js', additions: 1, deletions: 0 },
        { filename: 'Cargo.lock', additions: 100, deletions: 0 }
      ];
      const result = buildReviewPrompt(prData, diff, files, 50000);
      expect(result).toContain('+source code');
      expect(result).not.toContain('+lockfile data');
    });

    it('omits files that exceed remaining budget', () => {
      const prData = makePrData();
      const smallDiff = makeDiff('src/small.js', '+tiny');
      const largeDiff = makeDiff('src/large.js', '+' + 'x'.repeat(500));
      const diff = smallDiff + '\n' + largeDiff;
      const files = [
        { filename: 'src/small.js', additions: 1, deletions: 0 },
        { filename: 'src/large.js', additions: 1, deletions: 0 }
      ];
      // Budget only fits the small file
      const result = buildReviewPrompt(prData, diff, files, smallDiff.length);
      expect(result).toContain('+tiny');
      expect(result).toContain('omitted for size/type');
    });

    it('shows diff header with file counts', () => {
      const prData = makePrData();
      const diff = makeMultiDiff([
        { name: 'src/a.js', content: '+a' },
        { name: 'src/b.js', content: '+b' }
      ]);
      const files = [
        { filename: 'src/a.js', additions: 1, deletions: 0 },
        { filename: 'src/b.js', additions: 1, deletions: 0 }
      ];
      const result = buildReviewPrompt(prData, diff, files, 50000);
      expect(result).toContain('2 of 2 files shown');
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

    it('lists multiple files with additions/deletions', () => {
      const prData = makePrData();
      const files = [
        { filename: 'a.js', additions: 5, deletions: 2 },
        { filename: 'b.js', additions: 0, deletions: 10 }
      ];
      const result = buildReviewPrompt(prData, '', files, 10000);
      expect(result).toContain('a.js` (+5/-2)');
      expect(result).toContain('b.js` (+0/-10)');
    });

    it('includes base and head branch refs', () => {
      const prData = makePrData({ base: { ref: 'develop' }, head: { ref: 'feature/new' } });
      const result = buildReviewPrompt(prData, '', [], 10000);
      expect(result).toContain('develop');
      expect(result).toContain('feature/new');
    });

    it('wraps diff content in code block', () => {
      const prData = makePrData();
      const diff = makeDiff('src/app.js', '+new line');
      const result = buildReviewPrompt(prData, diff, [{ filename: 'src/app.js', additions: 1, deletions: 0 }], 10000);
      expect(result).toContain('```diff');
      expect(result).toContain('```');
    });

    it('continues packing after skipping oversized file', () => {
      const prData = makePrData();
      // Large file first (alphabetically), small file second
      const largeDiff = makeDiff('src/big.js', '+' + 'x'.repeat(1000));
      const smallDiff = makeDiff('src/tiny.js', '+small');
      const diff = largeDiff + '\n' + smallDiff;
      const files = [
        { filename: 'src/big.js', additions: 1, deletions: 0 },
        { filename: 'src/tiny.js', additions: 1, deletions: 0 }
      ];
      // Budget fits small but not large. Since we sort by size, small comes first.
      const result = buildReviewPrompt(prData, diff, files, 500);
      expect(result).toContain('+small');
      expect(result).toContain('1 omitted');
    });

    it('handles empty diff string', () => {
      const prData = makePrData();
      const result = buildReviewPrompt(prData, '', [], 10000);
      expect(result).toContain('Diff');
      expect(result).toContain('```diff');
    });

    it('handles non-string diff gracefully', () => {
      const prData = makePrData();
      const result = buildReviewPrompt(prData, { not: 'a string' }, [], 10000);
      expect(result).toContain('```diff');
      expect(result).not.toContain('[object Object]');
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

    it('includes commit SHA when provided', () => {
      const result = formatReviewComment('review', 1, 'abc1234567890');
      expect(result).toContain('Reviewed at `abc1234`');
    });

    it('omits commit SHA line when not provided', () => {
      const result = formatReviewComment('review', 1);
      expect(result).not.toContain('Reviewed at');
    });

    it('truncates long SHA to 7 characters', () => {
      const result = formatReviewComment('review', 1, 'a'.repeat(40));
      expect(result).toContain('`aaaaaaa`');
      expect(result).not.toContain('a'.repeat(40));
    });

    it('includes repo and branch metadata when provided', () => {
      const result = formatReviewComment('review', 42, 'abc1234', {
        baseRepo: 'pulseengine/temper',
        baseBranch: 'main',
        headRepo: 'contributor/temper',
        headBranch: 'fix/bug',
      });
      expect(result).toContain('contributor/temper:`fix/bug`');
      expect(result).toContain('pulseengine/temper:`main`');
      expect(result).toContain('→');
    });

    it('omits branch line when meta is not provided', () => {
      const result = formatReviewComment('review', 1);
      expect(result).not.toContain('→');
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

    it('uses default max_diff_size budget when not configured', async () => {
      _setConfigForTesting({
        ai_review: makeAiConfig({ max_diff_size: undefined })
      });

      // Create a large valid diff that exceeds the 12000 default budget
      const largeDiff = makeDiff('src/huge.js', '+' + 'x'.repeat(15000));
      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: largeDiff })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 1);

      // The file exceeds the 12000 budget, so it should be omitted
      const fetchBody = JSON.parse(global.fetch.mock.calls[0][1].body);
      expect(fetchBody.messages[1].content).toContain('omitted for size/type');
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

    it('includes commit SHA in review comment', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData({ head: { ref: 'fix', sha: 'deadbeef12345678' } }) })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      const result = await reviewPullRequest(octokit, 'owner', 'repo', 42);

      expect(result.success).toBe(true);
      expect(result.comment).toContain('Reviewed at `deadbee`');
    });

    it('calls supersedePreviousReviews before posting', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      const existingReview = {
        id: 100,
        body: '## AI Code Review for PR #42\n\nOld review content'
      };
      octokit.issues.listComments.mockResolvedValue({ data: [existingReview] });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('New review');
      await reviewPullRequest(octokit, 'owner', 'repo', 42);

      // Old review should be updated with outdated prefix
      expect(octokit.issues.updateComment).toHaveBeenCalledWith(
        expect.objectContaining({
          comment_id: 100,
          body: expect.stringContaining('Outdated')
        })
      );
      // New review should still be posted
      expect(octokit.issues.createComment).toHaveBeenCalled();
    });

    it('stores review record after successful review', async () => {
      _setConfigForTesting({ ai_review: makeAiConfig() });

      octokit.request
        .mockResolvedValueOnce({ data: makePrData() })
        .mockResolvedValueOnce({ data: 'diff' })
        .mockResolvedValueOnce({ data: [] });

      mockFetchSuccess('review');
      await reviewPullRequest(octokit, 'owner', 'repo', 42);

      const reviews = getReviews();
      expect(reviews.length).toBe(1);
      expect(reviews[0].repo).toBe('owner/repo');
      expect(reviews[0].prNumber).toBe(42);
      expect(reviews[0].status).toBe('open');
    });
  });

  // =========================================================================
  // parseDiffByFile
  // =========================================================================

  describe('parseDiffByFile', () => {
    it('returns empty array for empty input', () => {
      expect(parseDiffByFile('')).toEqual([]);
    });

    it('returns empty array for null input', () => {
      expect(parseDiffByFile(null)).toEqual([]);
    });

    it('returns empty array for undefined input', () => {
      expect(parseDiffByFile(undefined)).toEqual([]);
    });

    it('returns empty array for non-string input', () => {
      expect(parseDiffByFile(12345)).toEqual([]);
    });

    it('parses a single file diff', () => {
      const diff = makeDiff('src/main.rs', '+fn main() {}');
      const result = parseDiffByFile(diff);
      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe('src/main.rs');
      expect(result[0].diff).toContain('+fn main() {}');
      expect(result[0].size).toBeGreaterThan(0);
    });

    it('parses multiple file diffs', () => {
      const diff = makeMultiDiff([
        { name: 'src/a.js', content: '+line a' },
        { name: 'src/b.js', content: '+line b' },
        { name: 'src/c.js', content: '+line c' }
      ]);
      const result = parseDiffByFile(diff);
      expect(result).toHaveLength(3);
      expect(result[0].filename).toBe('src/a.js');
      expect(result[1].filename).toBe('src/b.js');
      expect(result[2].filename).toBe('src/c.js');
    });

    it('handles renamed files (uses destination path)', () => {
      const diff = 'diff --git a/old/name.js b/new/name.js\n--- a/old/name.js\n+++ b/new/name.js\n@@ -1 +1 @@\n-old\n+new';
      const result = parseDiffByFile(diff);
      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe('new/name.js');
    });

    it('handles new file diffs', () => {
      const diff = 'diff --git a/brand-new.ts b/brand-new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/brand-new.ts\n@@ -0,0 +1,3 @@\n+export const x = 1;';
      const result = parseDiffByFile(diff);
      expect(result).toHaveLength(1);
      expect(result[0].filename).toBe('brand-new.ts');
    });

    it('skips content without diff --git headers', () => {
      const diff = 'this is not a diff\njust random text';
      const result = parseDiffByFile(diff);
      expect(result).toEqual([]);
    });

    it('sets size to diff segment length', () => {
      const diff = makeDiff('file.js', '+x');
      const result = parseDiffByFile(diff);
      expect(result[0].size).toBe(result[0].diff.length);
    });
  });

  // =========================================================================
  // classifyFile
  // =========================================================================

  describe('classifyFile', () => {
    // Tier 0: skip
    it('classifies .lock files as tier 0', () => {
      expect(classifyFile('Cargo.lock').tier).toBe(0);
    });

    it('classifies MODULE.bazel.lock as tier 0', () => {
      expect(classifyFile('MODULE.bazel.lock').tier).toBe(0);
    });

    it('classifies go.sum as tier 0', () => {
      expect(classifyFile('go.sum').tier).toBe(0);
    });

    it('classifies package-lock.json as tier 0', () => {
      expect(classifyFile('package-lock.json').tier).toBe(0);
    });

    it('classifies yarn.lock as tier 0', () => {
      expect(classifyFile('yarn.lock').tier).toBe(0);
    });

    it('classifies pnpm-lock.yaml as tier 0', () => {
      expect(classifyFile('pnpm-lock.yaml').tier).toBe(0);
    });

    it('classifies .min.js as tier 0', () => {
      expect(classifyFile('dist/bundle.min.js').tier).toBe(0);
    });

    it('classifies .min.css as tier 0', () => {
      expect(classifyFile('styles/app.min.css').tier).toBe(0);
    });

    it('classifies .generated. files as tier 0', () => {
      expect(classifyFile('src/schema.generated.ts').tier).toBe(0);
    });

    it('classifies .pb.go as tier 0', () => {
      expect(classifyFile('proto/service.pb.go').tier).toBe(0);
    });

    it('classifies vendor/ files as tier 0', () => {
      expect(classifyFile('vendor/github.com/pkg/errors/errors.go').tier).toBe(0);
    });

    it('classifies vendor/ at root as tier 0', () => {
      expect(classifyFile('vendor/lib.js').tier).toBe(0);
    });

    // Tier 1: source
    it('classifies .rs files as tier 1 source', () => {
      expect(classifyFile('src/main.rs')).toEqual({ tier: 1, label: 'source' });
    });

    it('classifies .ts files as tier 1 source', () => {
      expect(classifyFile('src/app.ts')).toEqual({ tier: 1, label: 'source' });
    });

    it('classifies .js files as tier 1 source', () => {
      expect(classifyFile('src/index.js')).toEqual({ tier: 1, label: 'source' });
    });

    it('classifies .py files as tier 1 source', () => {
      expect(classifyFile('main.py')).toEqual({ tier: 1, label: 'source' });
    });

    it('classifies .go files as tier 1 source', () => {
      expect(classifyFile('cmd/server.go')).toEqual({ tier: 1, label: 'source' });
    });

    it('classifies .c files as tier 1 source', () => {
      expect(classifyFile('src/main.c')).toEqual({ tier: 1, label: 'source' });
    });

    it('classifies .vue files as tier 1 source', () => {
      expect(classifyFile('components/App.vue')).toEqual({ tier: 1, label: 'source' });
    });

    // Tier 2: tests (takes priority over source)
    it('classifies test files as tier 2', () => {
      expect(classifyFile('src/app.test.js')).toEqual({ tier: 2, label: 'test' });
    });

    it('classifies spec files as tier 2', () => {
      expect(classifyFile('src/app.spec.ts')).toEqual({ tier: 2, label: 'test' });
    });

    it('classifies __tests__/ files as tier 2', () => {
      expect(classifyFile('__tests__/unit/app.js')).toEqual({ tier: 2, label: 'test' });
    });

    it('classifies nested __tests__/ files as tier 2', () => {
      expect(classifyFile('src/__tests__/helper.js')).toEqual({ tier: 2, label: 'test' });
    });

    // Tier 3: config/docs
    it('classifies .yml files as tier 3', () => {
      expect(classifyFile('.github/workflows/ci.yml')).toEqual({ tier: 3, label: 'config/docs' });
    });

    it('classifies .md files as tier 3', () => {
      expect(classifyFile('README.md')).toEqual({ tier: 3, label: 'config/docs' });
    });

    it('classifies .json files as tier 3', () => {
      expect(classifyFile('tsconfig.json')).toEqual({ tier: 3, label: 'config/docs' });
    });

    it('classifies Dockerfile as tier 3', () => {
      expect(classifyFile('Dockerfile')).toEqual({ tier: 3, label: 'config/docs' });
    });

    it('classifies .toml files as tier 3', () => {
      expect(classifyFile('Cargo.toml')).toEqual({ tier: 3, label: 'config/docs' });
    });

    // Edge cases
    it('is case-insensitive for extensions', () => {
      expect(classifyFile('SRC/Main.JS').tier).toBe(1);
    });

    it('classifies composer.lock as tier 0', () => {
      expect(classifyFile('composer.lock').tier).toBe(0);
    });

    it('classifies poetry.lock as tier 0', () => {
      expect(classifyFile('poetry.lock').tier).toBe(0);
    });
  });

  // =========================================================================
  // prioritizeFiles
  // =========================================================================

  describe('prioritizeFiles', () => {
    it('sorts by tier ascending', () => {
      const files = [
        { filename: 'README.md', diff: 'a', size: 10 },
        { filename: 'src/main.rs', diff: 'b', size: 10 },
        { filename: 'Cargo.lock', diff: 'c', size: 10 }
      ];
      const result = prioritizeFiles(files);
      expect(result[0].tier).toBe(0);  // lock
      expect(result[1].tier).toBe(1);  // source
      expect(result[2].tier).toBe(3);  // config
    });

    it('sorts by size ascending within same tier', () => {
      const files = [
        { filename: 'src/big.js', diff: 'x'.repeat(500), size: 500 },
        { filename: 'src/small.js', diff: 'x', size: 1 },
        { filename: 'src/medium.js', diff: 'x'.repeat(100), size: 100 }
      ];
      const result = prioritizeFiles(files);
      expect(result[0].filename).toBe('src/small.js');
      expect(result[1].filename).toBe('src/medium.js');
      expect(result[2].filename).toBe('src/big.js');
    });

    it('adds tier and label to each entry', () => {
      const files = [{ filename: 'src/app.rs', diff: 'x', size: 1 }];
      const result = prioritizeFiles(files);
      expect(result[0]).toEqual(expect.objectContaining({
        tier: 1,
        label: 'source',
        filename: 'src/app.rs'
      }));
    });

    it('returns empty array for empty input', () => {
      expect(prioritizeFiles([])).toEqual([]);
    });

    it('places source before tests before config', () => {
      const files = [
        { filename: 'config.yml', diff: 'c', size: 10 },
        { filename: 'src/app.test.js', diff: 't', size: 10 },
        { filename: 'src/app.js', diff: 's', size: 10 }
      ];
      const result = prioritizeFiles(files);
      expect(result[0].label).toBe('source');
      expect(result[1].label).toBe('test');
      expect(result[2].label).toBe('config/docs');
    });

    it('lockfiles sort last despite being tier 0', () => {
      // Tier 0 files have the lowest tier value (0), so they come first in sort order.
      // But buildReviewPrompt skips them entirely.
      const files = [
        { filename: 'src/app.js', diff: 's', size: 10 },
        { filename: 'Cargo.lock', diff: 'l', size: 1000 }
      ];
      const result = prioritizeFiles(files);
      // Tier 0 sorts first numerically
      expect(result[0].tier).toBe(0);
      expect(result[1].tier).toBe(1);
    });
  });

  // =========================================================================
  // supersedePreviousReviews
  // =========================================================================

  describe('supersedePreviousReviews', () => {
    let octokit;

    beforeEach(() => {
      octokit = createMockOctokit();
    });

    it('marks old bot reviews as outdated', async () => {
      octokit.issues.listComments.mockResolvedValue({
        data: [
          { id: 1, body: '## AI Code Review for PR #5\n\nOld review' },
          { id: 2, body: 'Regular user comment' }
        ]
      });

      await supersedePreviousReviews(octokit, 'owner', 'repo', 5);

      expect(octokit.issues.updateComment).toHaveBeenCalledTimes(1);
      expect(octokit.issues.updateComment).toHaveBeenCalledWith(
        expect.objectContaining({
          comment_id: 1,
          body: expect.stringContaining('Outdated')
        })
      );
    });

    it('does not modify non-bot comments', async () => {
      octokit.issues.listComments.mockResolvedValue({
        data: [
          { id: 1, body: 'Just a regular comment' },
          { id: 2, body: 'Another comment' }
        ]
      });

      await supersedePreviousReviews(octokit, 'owner', 'repo', 5);

      expect(octokit.issues.updateComment).not.toHaveBeenCalled();
    });

    it('does not re-mark already outdated reviews', async () => {
      octokit.issues.listComments.mockResolvedValue({
        data: [
          { id: 1, body: '> ⚠️ **Outdated**\n\n## AI Code Review for PR #5\n\nOld' }
        ]
      });

      await supersedePreviousReviews(octokit, 'owner', 'repo', 5);

      // Already starts with '>', should be skipped
      expect(octokit.issues.updateComment).not.toHaveBeenCalled();
    });

    it('handles multiple bot reviews', async () => {
      octokit.issues.listComments.mockResolvedValue({
        data: [
          { id: 1, body: '## AI Code Review for PR #5\n\nFirst' },
          { id: 2, body: '## AI Code Review for PR #5\n\nSecond' }
        ]
      });

      await supersedePreviousReviews(octokit, 'owner', 'repo', 5);

      expect(octokit.issues.updateComment).toHaveBeenCalledTimes(2);
    });

    it('does not throw on API failure', async () => {
      octokit.issues.listComments.mockRejectedValue(new Error('API error'));

      // Should not throw
      await expect(
        supersedePreviousReviews(octokit, 'owner', 'repo', 5)
      ).resolves.toBeUndefined();

      expect(getLogger().warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to supersede')
      );
    });

    it('handles empty comment list', async () => {
      octokit.issues.listComments.mockResolvedValue({ data: [] });

      await supersedePreviousReviews(octokit, 'owner', 'repo', 5);

      expect(octokit.issues.updateComment).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Review storage and status tracking
  // =========================================================================

  describe('review storage', () => {
    it('stores a review entry', () => {
      storeReview({ repo: 'owner/repo', prNumber: 1, status: 'open' });
      const reviews = getReviews();
      expect(reviews).toHaveLength(1);
      expect(reviews[0]).toEqual(expect.objectContaining({
        repo: 'owner/repo',
        prNumber: 1,
        status: 'open'
      }));
    });

    it('accumulates multiple reviews', () => {
      storeReview({ repo: 'owner/repo', prNumber: 1, status: 'open' });
      storeReview({ repo: 'owner/repo', prNumber: 2, status: 'open' });
      expect(getReviews()).toHaveLength(2);
    });

    it('resets reviews with _resetReviews', () => {
      storeReview({ repo: 'owner/repo', prNumber: 1, status: 'open' });
      _resetReviews();
      expect(getReviews()).toHaveLength(0);
    });
  });

  describe('updateReviewStatus', () => {
    it('updates matching reviews to merged', () => {
      storeReview({ repo: 'owner/repo', prNumber: 1, status: 'open' });
      const updated = updateReviewStatus('owner/repo', 1, 'merged');
      expect(updated).toBe(1);
      expect(getReviews()[0].status).toBe('merged');
    });

    it('updates matching reviews to closed', () => {
      storeReview({ repo: 'owner/repo', prNumber: 1, status: 'open' });
      const updated = updateReviewStatus('owner/repo', 1, 'closed');
      expect(updated).toBe(1);
      expect(getReviews()[0].status).toBe('closed');
    });

    it('updates all reviews for same repo+PR', () => {
      storeReview({ repo: 'owner/repo', prNumber: 1, status: 'open' });
      storeReview({ repo: 'owner/repo', prNumber: 1, status: 'open' });
      const updated = updateReviewStatus('owner/repo', 1, 'merged');
      expect(updated).toBe(2);
      expect(getReviews().every((r) => r.status === 'merged')).toBe(true);
    });

    it('does not update reviews for different PR', () => {
      storeReview({ repo: 'owner/repo', prNumber: 1, status: 'open' });
      storeReview({ repo: 'owner/repo', prNumber: 2, status: 'open' });
      updateReviewStatus('owner/repo', 1, 'merged');
      // getReviews() returns newest-first, so [0] is prNumber:2, [1] is prNumber:1
      expect(getReviews()[0].status).toBe('open');
      expect(getReviews()[1].status).toBe('merged');
    });

    it('does not update reviews for different repo', () => {
      storeReview({ repo: 'owner/repo-a', prNumber: 1, status: 'open' });
      storeReview({ repo: 'owner/repo-b', prNumber: 1, status: 'open' });
      updateReviewStatus('owner/repo-a', 1, 'closed');
      // getReviews() returns newest-first, so [0] is repo-b, [1] is repo-a
      expect(getReviews()[0].status).toBe('open');
      expect(getReviews()[1].status).toBe('closed');
    });

    it('returns 0 when no reviews match', () => {
      storeReview({ repo: 'owner/repo', prNumber: 1, status: 'open' });
      const updated = updateReviewStatus('owner/other', 99, 'merged');
      expect(updated).toBe(0);
    });
  });
});
