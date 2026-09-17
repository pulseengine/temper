import {
  parseVersion,
  isBreakingUpdate,
  extractUpdates,
  dependabotAutoMergeDecision
} from '../../src/dependabot-update-type.js';

// Every title and body below is copied from a real Dependabot PR in the
// pulseengine org. Synthetic strings would test the parser against what we
// expected Dependabot to write; these test it against what it did write.

describe('dependabot-update-type', () => {
  describe('parseVersion', () => {
    it('reads a plain semver', () => {
      expect(parseVersion('4.4.0')).toEqual([4, 4, 0]);
    });

    it('drops build metadata (toml writes 0.9.12+spec-1.1.0)', () => {
      expect(parseVersion('0.9.12+spec-1.1.0')).toEqual([0, 9, 12]);
    });

    it('pads a one-component version (actions/deploy-pages from 4 to 5)', () => {
      expect(parseVersion('4')).toEqual([4, 0, 0]);
    });

    it('strips requirement operators (sphinxcontrib-rust from >=1.2.0)', () => {
      expect(parseVersion('>=1.2.0')).toEqual([1, 2, 0]);
    });

    it('strips a trailing full stop from a Bumps summary line', () => {
      expect(parseVersion('0.8.0.')).toEqual([0, 8, 0]);
    });

    it('returns null for something that is not a version (a commit SHA)', () => {
      expect(parseVersion('3d3c42e5aac5ba805825da76410c181273ba90b1')).toBeNull();
    });
  });

  describe('isBreakingUpdate', () => {
    it('treats a major change as breaking', () => {
      expect(isBreakingUpdate([3, 9, 1], [4, 1, 2])).toBe(true);
    });

    it('treats a 0.x minor change as breaking, as Cargo and npm caret ranges do', () => {
      // criterion 0.7 -> 0.8, wsc-attestation 0.10 -> 0.11
      expect(isBreakingUpdate([0, 7, 0], [0, 8, 2])).toBe(true);
      expect(isBreakingUpdate([0, 10, 0], [0, 11, 0])).toBe(true);
    });

    it('treats a 0.0.x patch change as breaking', () => {
      expect(isBreakingUpdate([0, 0, 3], [0, 0, 4])).toBe(true);
    });

    it('does not treat a minor or patch on a 1.x+ line as breaking', () => {
      expect(isBreakingUpdate([3, 3, 0], [3, 4, 2])).toBe(false); // ureq
      expect(isBreakingUpdate([1, 1, 9], [1, 1, 10])).toBe(false); // flate2
    });

    it('does not treat a 0.x patch change as breaking', () => {
      expect(isBreakingUpdate([0, 7, 3], [0, 7, 4])).toBe(false);
    });
  });

  describe('extractUpdates', () => {
    it('reads a single-update title', () => {
      expect(extractUpdates('build(deps): bump actions/checkout from 4.4.0 to 7.0.1', '')).toEqual([
        { name: 'actions/checkout', from: '4.4.0', to: '7.0.1' }
      ]);
    });

    it('ignores a trailing "in the <group> group" suffix', () => {
      const u = extractUpdates(
        'chore(deps): Bump wasmtime-wasi from 48.0.1 to 48.0.2 in the wasmtime group',
        ''
      );
      expect(u).toEqual([{ name: 'wasmtime-wasi', from: '48.0.1', to: '48.0.2' }]);
    });

    it('reads a "requirement" update with a directory suffix', () => {
      const u = extractUpdates(
        'build(deps): update wit-bindgen requirement from 0.60.0 to 0.62.0 in /fuzz',
        ''
      );
      expect(u).toEqual([{ name: 'wit-bindgen', from: '0.60.0', to: '0.62.0' }]);
    });

    it('reads EVERY update from a grouped PR body, whose title names no versions', () => {
      const body = [
        'Bumps the wasmtime group with 2 updates in the / directory: [wasmtime](https://github.com/bytecodealliance/wasmtime) and [wasmtime-wasi](https://github.com/bytecodealliance/wasmtime).',
        'Updates `wasmtime` from 47.0.3 to 48.0.1',
        'Updates `wasmtime-wasi` from 47.0.3 to 48.0.1'
      ].join('\n');
      const u = extractUpdates('chore(deps): Bump the wasmtime group across 1 directory with 2 updates', body);
      // Two DIFFERENT packages moving from the same version to the same
      // version. Keying on versions alone collapsed these into one.
      expect(u).toEqual([
        { name: 'wasmtime', from: '47.0.3', to: '48.0.1' },
        { name: 'wasmtime-wasi', from: '47.0.3', to: '48.0.1' }
      ]);
    });

    it('does NOT read "from X to Y" out of embedded release notes', () => {
      // Dependabot bodies quote upstream changelogs, which say things like
      // "migrate from v1 to v2". Reading those would invent updates.
      const body = [
        'Bumps [ureq](https://github.com/algesten/ureq) from 3.3.0 to 3.4.2.',
        '<details><summary>Changelog</summary>',
        '<li>Upgrade path from 2.0.0 to 9.0.0 documented</li>',
        '</details>'
      ].join('\n');
      const u = extractUpdates('build(deps): bump ureq from 3.3.0 to 3.4.2', body);
      expect(u).toEqual([{ name: 'ureq', from: '3.3.0', to: '3.4.2' }]);
    });
  });

  describe('dependabotAutoMergeDecision', () => {
    it('allows a patch bump', () => {
      const d = dependabotAutoMergeDecision('build(deps): bump flate2 from 1.1.9 to 1.1.10', '');
      expect(d.allow).toBe(true);
    });

    it('allows a minor bump on a stable line', () => {
      const d = dependabotAutoMergeDecision('build(deps): bump ureq from 3.3.0 to 3.4.2', '');
      expect(d.allow).toBe(true);
    });

    it('REFUSES a major bump to a signing toolchain', () => {
      const d = dependabotAutoMergeDecision(
        'build(deps): bump sigstore/cosign-installer from 3.9.1 to 4.1.2',
        ''
      );
      expect(d.allow).toBe(false);
      expect(d.reason).toMatch(/breaking/i);
      expect(d.reason).toContain('sigstore/cosign-installer');
      expect(d.reason).toContain('3.9.1');
      expect(d.reason).toContain('4.1.2');
    });

    it('REFUSES a 0.x minor bump, which is breaking under Cargo semver', () => {
      const d = dependabotAutoMergeDecision('build(deps): bump criterion from 0.7.0 to 0.8.2', '');
      expect(d.allow).toBe(false);
    });

    it('REFUSES a grouped PR when any one update inside it is breaking', () => {
      // witness#211: the group is called "wasmtime" and says nothing about
      // semver, but it carries 47 -> 48.
      const body = [
        'Updates `wasmtime` from 47.0.3 to 48.0.1',
        'Updates `wasmtime-wasi` from 47.0.3 to 48.0.1'
      ].join('\n');
      const d = dependabotAutoMergeDecision(
        'chore(deps): Bump the wasmtime group across 1 directory with 2 updates',
        body
      );
      expect(d.allow).toBe(false);
    });

    it('allows a grouped PR whose every update is non-breaking', () => {
      const body = [
        'Updates `ureq` from 3.3.0 to 3.4.2',
        'Updates `flate2` from 1.1.9 to 1.1.10'
      ].join('\n');
      const d = dependabotAutoMergeDecision(
        'build(deps): bump the cargo-minor-and-patch group with 2 updates',
        body
      );
      expect(d.allow).toBe(true);
    });

    it('REFUSES when no update can be read at all, rather than assuming it is safe', () => {
      const d = dependabotAutoMergeDecision('build(deps): something unrecognised', '');
      expect(d.allow).toBe(false);
      expect(d.reason).toMatch(/could not/i);
    });

    it('REFUSES when a version is not semver, e.g. a SHA-only action update', () => {
      const d = dependabotAutoMergeDecision(
        'build(deps): bump actions/checkout from 3d3c42e5aac5ba805825da76410c181273ba90b1 to 11d5960a326750d5838078e36cf38b85af677262',
        ''
      );
      expect(d.allow).toBe(false);
    });
  });
});
