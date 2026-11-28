import { parseRequiredContexts } from '../../src/required-contexts.js';

describe('parseRequiredContexts', () => {
  it('reads one context per line', () => {
    expect(parseRequiredContexts('test\nlint\nci\n')).toEqual(['test', 'lint', 'ci']);
  });

  it('skips a # header, indented # lines and blank lines, so none becomes a context', () => {
    const text = '# Mirrors main\'s required status checks.\n#\n  # kept in step by hand\n\ntest\n\n  lint  \r\nci';
    expect(parseRequiredContexts(text)).toEqual(['test', 'lint', 'ci']);
  });

  it('keeps a # that is not the first non-blank character', () => {
    expect(parseRequiredContexts('build #1\n')).toEqual(['build #1']);
  });

  it('refuses a file with no context: empty, blank, or only comments', () => {
    for (const text of ['', '\n\n', '# header only\n#\n', '   \n  # x\n']) {
      expect(() => parseRequiredContexts(text)).toThrow('lists no context');
    }
  });

  it('refuses something that is not text', () => {
    expect(() => parseRequiredContexts(undefined)).toThrow('not text');
  });
});
