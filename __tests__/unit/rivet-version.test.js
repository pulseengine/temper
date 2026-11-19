// temper#94: the two inputs of the oracle's version gate, parsed from what
// GitHub and the rivet binary actually return.

import { repoVarveLayer } from '../../src/rivet-fetch.js';
import { rivetBinaryVersion } from '../../src/rivet-oracle.js';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const octokitWith = (impl) => ({ request: jest.fn(impl) });

describe('repoVarveLayer', () => {
  it('reads the layer from varve.toml at the ref', async () => {
    const toml = 'manifest-version = 1\n\n[toolchain]\nrealm   = "pulseengine"\nchannel = "rolling"\nlayer   = "2026.11.0"\n';
    const gh = octokitWith(() => Promise.resolve({ data: { content: b64(toml) } }));
    await expect(repoVarveLayer(gh, 'org', 'r', 'abc')).resolves.toBe('2026.11.0');
    expect(gh.request).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/contents/{path}',
      { owner: 'org', repo: 'r', path: 'varve.toml', ref: 'abc' });
  });

  it('is null without a pin, without a layer line, or on an API error', async () => {
    const e404 = Object.assign(new Error('Not Found'), { status: 404 });
    await expect(repoVarveLayer(octokitWith(() => Promise.reject(e404)), 'o', 'r', 'x')).resolves.toBeNull();
    const noLayer = octokitWith(() => Promise.resolve({ data: { content: b64('[toolchain]\nrealm = "x"\n') } }));
    await expect(repoVarveLayer(noLayer, 'o', 'r', 'x')).resolves.toBeNull();
    // a commented-out layer is not a pin
    const commented = octokitWith(() => Promise.resolve({ data: { content: b64('# layer = "2026.11.0"\n') } }));
    await expect(repoVarveLayer(commented, 'o', 'r', 'x')).resolves.toBeNull();
  });
});

describe('rivetBinaryVersion', () => {
  it('parses `rivet <semver> (...)`', async () => {
    const runner = jest.fn().mockResolvedValue({ stdout: 'rivet 0.41.1 (29ca4382 HEAD 2026-10-22)\n' });
    await expect(rivetBinaryVersion('/bin/rivet', { runner })).resolves.toBe('0.41.1');
    expect(runner).toHaveBeenCalledWith('/bin/rivet', ['--version'], expect.any(Object));
    const old = jest.fn().mockResolvedValue({ stdout: 'rivet 0.4.3 (f25e592e, 2026-04-23)\n' });
    await expect(rivetBinaryVersion('/bin/rivet', { runner: old })).resolves.toBe('0.4.3');
  });

  it('is null when the binary is missing or prints something else', async () => {
    const missing = jest.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(rivetBinaryVersion('/nope', { runner: missing })).resolves.toBeNull();
    const other = jest.fn().mockResolvedValue({ stdout: 'spar 0.9.0\n' });
    await expect(rivetBinaryVersion('/bin/x', { runner: other })).resolves.toBeNull();
  });
});
