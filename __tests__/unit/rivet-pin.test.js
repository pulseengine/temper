// Per-repo rivet resolution (temper#94 follow-up): the pin parser, the pin
// validator, and the pin directory temper writes for `varve which rivet`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseVarvePin, validateVarvePin, resolvePinnedRivet } from '../../src/rivet-oracle.js';

const TEMPER_PIN = `manifest-version = 1

[toolchain]
realm   = "pulseengine"
channel = "rolling"
layer   = "2026.11.0"
`;

describe('parseVarvePin', () => {
  it('reads realm, channel and layer from [toolchain]', () => {
    expect(parseVarvePin(TEMPER_PIN)).toEqual({ realm: 'pulseengine', channel: 'rolling', layer: '2026.11.0' });
  });
  it('ignores comments and keys outside [toolchain]', () => {
    const t = '[other]\nlayer = "9999.1.1"\n[toolchain]\nrealm = "covalent" # c\nchannel = "rolling"\n# layer = "1.1.1"\nlayer = "2026.11.16"\n';
    expect(parseVarvePin(t)).toEqual({ realm: 'covalent', channel: 'rolling', layer: '2026.11.16' });
  });
  it('is null without a layer or for non-text', () => {
    expect(parseVarvePin('[toolchain]\nrealm = "pulseengine"\n')).toBeNull();
    expect(parseVarvePin('[other]\nlayer = "2026.11.0"\n')).toBeNull();
    expect(parseVarvePin(undefined)).toBeNull();
  });
});

describe('validateVarvePin', () => {
  const allowed = ['pulseengine', 'covalent'];
  const ok = { realm: 'pulseengine', channel: 'rolling', layer: '2026.11.16' };
  it('accepts an allowed realm with a dated layer', () => {
    expect(validateVarvePin(ok, allowed)).toEqual({ ok: true });
  });
  it.each([
    ['no pin', null, /pins no varve layer/],
    ['a realm not allowed', { ...ok, realm: 'attacker' }, /not in rivet_oracle.realms_allowed/],
    ['a realm with a path', { ...ok, realm: '../pulseengine' }, /no valid realm/],
    ['a missing channel', { ...ok, channel: undefined }, /no valid channel/],
    ['a channel with a slash', { ...ok, channel: 'a/b' }, /no valid channel/],
    ['a layer with a path', { ...ok, layer: '../../etc' }, /no valid layer/],
    ['a layer with a quote', { ...ok, layer: '2026.11.0"\nrealm = "x' }, /no valid layer/]
  ])('rejects %s', (_, pin, reason) => {
    const v = validateVarvePin(pin, allowed);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(reason);
  });
  it('rejects every realm when none is allowed', () => {
    expect(validateVarvePin(ok, undefined).ok).toBe(false);
  });
});

describe('resolvePinnedRivet', () => {
  let tmp;
  let realmsFile;
  const pin = { realm: 'pulseengine', channel: 'rolling', layer: '2026.11.16' };
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'temper-pin-'));
    realmsFile = path.join(tmp, 'trusted-realms.toml');
    fs.writeFileSync(realmsFile, '[realm.pulseengine]\ntrust-root = "deploy"\n');
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const args = (runner) => ({
    pin, runner, realmsFile,
    varveBinary: '/usr/local/bin/varve', pinsDir: path.join(tmp, 'pins'), storesDir: '/var/lib/temper/stores'
  });

  it('writes its own pin dir from the trusted realms file and resolves there', async () => {
    const runner = jest.fn().mockResolvedValue({
      // varve 0.47: binary on stdout, resolved layer on stderr (checked live).
      stdout: '/var/lib/varve/core/x/bin/rivet\n',
      stderr: 'layer 2026.11.16 (rolling) sha256:ab\n'
    });
    const r = await resolvePinnedRivet(args(runner));
    expect(r).toEqual({ ok: true, binary: '/var/lib/varve/core/x/bin/rivet' });
    const dir = path.join(tmp, 'pins', 'pulseengine', 'rolling', '2026.11.16');
    const [bin, argv, opts] = runner.mock.calls[0];
    expect([bin, argv]).toEqual(['/usr/local/bin/varve', ['which', 'rivet']]);
    expect(opts.cwd).toBe(dir);
    // One store per pin (varve#256: anti-rollback is per line per store).
    expect(opts.env.VARVE_ROOT).toBe('/var/lib/temper/stores/pulseengine/rolling/2026.11.16');
    expect(fs.readFileSync(path.join(dir, 'varve.toml'), 'utf8')).toBe(TEMPER_PIN.replace('2026.11.0', '2026.11.16'));
    expect(fs.readFileSync(path.join(dir, 'varve-realms.toml'), 'utf8')).toBe(fs.readFileSync(realmsFile, 'utf8'));
  });

  it('a layer not installed is a skip reason, not an install', async () => {
    const err = Object.assign(new Error('exit 1'), {
      stderr: 'error: layer 2026.11.16 is not installed — run `varve install` in this project to lay it down\n'
    });
    const runner = jest.fn().mockRejectedValue(err);
    const r = await resolvePinnedRivet(args(runner));
    expect(r).toEqual({ ok: false, reason: 'layer pulseengine/2026.11.16 is not installed on this host' });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner.mock.calls[0][1]).toEqual(['which', 'rivet']);
  });

  it.each([
    ['another layer', '/x/bin/rivet\n', 'layer 2026.11.0 (rolling) sha256:ab\n'],
    ['a relative path', 'bin/rivet\n', 'layer 2026.11.16 (rolling) sha256:ab\n'],
    ['no layer line', '/x/bin/rivet\n', ''],
    ['a layer that only shares a prefix', '/x/bin/rivet\n', 'layer 2026.11.160 (rolling) sha256:ab\n']
  ])('refuses varve output naming %s', async (_, stdout, stderr) => {
    const r = await resolvePinnedRivet(args(jest.fn().mockResolvedValue({ stdout, stderr })));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/unexpected output/);
  });

  it('a missing realms file is a skip', async () => {
    const runner = jest.fn();
    const r = await resolvePinnedRivet({ ...args(runner), realmsFile: path.join(tmp, 'nope') });
    expect(r.ok).toBe(false);
    expect(runner).not.toHaveBeenCalled();
  });
});
