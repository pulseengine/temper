jest.mock('../../src/logger.js', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { getLogger: () => log, setLogger: jest.fn() };
});

import { assertWebhookSecret } from '../../src/app.js';

describe('assertWebhookSecret (Bug #2 — trust-boundary fail-fast)', () => {
  it('throws when WEBHOOK_SECRET is missing', () => {
    expect(() => assertWebhookSecret({})).toThrow(/required/i);
  });

  it('throws when WEBHOOK_SECRET is the empty string', () => {
    expect(() => assertWebhookSecret({ WEBHOOK_SECRET: '' })).toThrow(/required/i);
  });

  it('throws when WEBHOOK_SECRET is whitespace-only', () => {
    expect(() => assertWebhookSecret({ WEBHOOK_SECRET: '   ' })).toThrow(/required/i);
  });

  it('throws when WEBHOOK_SECRET equals the literal "development"', () => {
    expect(() => assertWebhookSecret({ WEBHOOK_SECRET: 'development' })).toThrow(
      /"development"/
    );
  });

  it('does NOT throw when WEBHOOK_SECRET merely contains "development" as substring', () => {
    // Exact-match only — a real secret may legitimately have the word.
    expect(() =>
      assertWebhookSecret({ WEBHOOK_SECRET: 'development-secret-9f2c' })
    ).not.toThrow();
    expect(() =>
      assertWebhookSecret({ WEBHOOK_SECRET: 'predev-elopment' })
    ).not.toThrow();
  });

  it('passes for a non-trivial secret', () => {
    expect(() =>
      assertWebhookSecret({ WEBHOOK_SECRET: 'a1b2c3d4e5f6g7h8i9j0' })
    ).not.toThrow();
  });

  it('reads from process.env by default', () => {
    const original = process.env.WEBHOOK_SECRET;
    process.env.WEBHOOK_SECRET = 'real-secret-here';
    try {
      expect(() => assertWebhookSecret()).not.toThrow();
    } finally {
      if (original === undefined) delete process.env.WEBHOOK_SECRET;
      else process.env.WEBHOOK_SECRET = original;
    }
  });
});
