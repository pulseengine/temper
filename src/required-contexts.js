/**
 * Reader for a repo's .github/required-contexts.txt: the plain-text mirror of
 * the default branch's required status checks, which sieve and temper read.
 * Same rules as sieve v0.4.5: one context per line, surrounding whitespace
 * trimmed, blank lines skipped, and a line whose first non-blank character
 * is '#' is a comment. A '#' later in a line is part of the context.
 * Trimming also drops the '\r' of a CRLF line ending.
 */
export function parseRequiredContexts(text) {
  if (typeof text !== 'string') throw new Error('required-contexts.txt is not text');
  const contexts = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  // An empty mirror would read as "no required checks": refuse it rather than
  // report a repo as matching nothing.
  if (contexts.length === 0) throw new Error('required-contexts.txt lists no context');
  return contexts;
}
