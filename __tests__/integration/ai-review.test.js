const {
  buildReviewPrompt,
  formatReviewComment,
  isLocalEndpoint,
  sanitizeAIOutput,
  _reviewTimestamps
} = require('../../src/ai-review');

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
  });

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
  });

  describe('buildReviewPrompt', () => {
    it('builds a prompt with PR data', () => {
      const prData = { number: 42, title: 'Fix bug', user: { login: 'dev' }, base: { ref: 'main' }, head: { ref: 'fix' }, body: 'Fixes #1' };
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
      const prData = { number: 1, title: 'T', user: { login: 'u' }, base: { ref: 'm' }, head: { ref: 'f' }, body: '' };
      const diff = 'x'.repeat(200);
      const result = buildReviewPrompt(prData, diff, [], 100);
      expect(result).toContain('[... diff truncated due to size ...]');
    });

    it('does not truncate small diffs', () => {
      const prData = { number: 1, title: 'T', user: { login: 'u' }, base: { ref: 'm' }, head: { ref: 'f' }, body: '' };
      const diff = 'small diff';
      const result = buildReviewPrompt(prData, diff, [], 10000);
      expect(result).not.toContain('[... diff truncated due to size ...]');
      expect(result).toContain('small diff');
    });

    it('handles empty body', () => {
      const prData = { number: 1, title: 'T', user: { login: 'u' }, base: { ref: 'm' }, head: { ref: 'f' }, body: null };
      const result = buildReviewPrompt(prData, '', [], 10000);
      expect(result).toContain('(no description)');
    });

    it('lists multiple files', () => {
      const prData = { number: 1, title: 'T', user: { login: 'u' }, base: { ref: 'm' }, head: { ref: 'f' }, body: '' };
      const files = [
        { filename: 'a.js', additions: 5, deletions: 2 },
        { filename: 'b.js', additions: 0, deletions: 10 }
      ];
      const result = buildReviewPrompt(prData, '', files, 10000);
      expect(result).toContain('a.js (+5/-2)');
      expect(result).toContain('b.js (+0/-10)');
    });
  });

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
  });

  describe('_reviewTimestamps', () => {
    it('is a Map for rate limiting', () => {
      expect(_reviewTimestamps).toBeInstanceOf(Map);
    });

    afterEach(() => {
      _reviewTimestamps.clear();
    });

    it('can track review timestamps', () => {
      _reviewTimestamps.set('org/repo#1', Date.now());
      expect(_reviewTimestamps.has('org/repo#1')).toBe(true);
    });
  });
});
