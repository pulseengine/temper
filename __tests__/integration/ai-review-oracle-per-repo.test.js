// The rivet oracle resolves the rivet each repository pins (temper#94
// follow-up): head and base each run their own pinned rivet, and a pin the
// deploy does not trust, or a layer the host has not installed, is a logged
// skip that names the repository.

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

jest.mock('../../src/rivet-fetch.js', () => ({
  hasRivetYaml: jest.fn().mockResolvedValue(true),
  repoVarveLayer: jest.fn().mockResolvedValue(null),
  repoVarvePin: jest.fn(),
  withTempRepoCheckout: jest.fn((octokit, owner, repo, ref, fn) => fn(`/tmp/checkout-${ref}`))
}));

jest.mock('../../src/rivet-oracle.js', () => {
  const actual = jest.requireActual('../../src/rivet-oracle.js');
  return {
    ...actual,
    runRivetOracle: jest.fn(),
    rivetBinaryVersion: jest.fn(),
    runRivetValidate: jest.fn().mockResolvedValue({ ok: true, findings: [] }),
    resolvePinnedRivet: jest.fn()
  };
});

import { reviewPullRequest, reviewStatus, _reviewTimestamps, _resetReviews } from '../../src/ai-review.js';
import { _setConfigForTesting } from '../../src/config.js';
import { runRivetOracle, runRivetValidate, resolvePinnedRivet, rivetBinaryVersion } from '../../src/rivet-oracle.js';
import { repoVarvePin } from '../../src/rivet-fetch.js';
import { getLogger } from '../../src/logger.js';

const ORACLE = {
  enabled: true,
  timeout_ms: 60000,
  varve_binary: '/usr/local/bin/varve',
  stores_dir: '/var/lib/temper/stores',
  pins_dir: '/var/lib/temper/pins',
  realms_file: '/etc/temper/varve-realms.toml',
  realms_allowed: ['pulseengine', 'covalent']
};

const pin = (layer, realm = 'pulseengine') => ({ realm, channel: 'rolling', layer });
const bin = (layer) => `/var/lib/varve/realms/x/core/${layer}/bin/rivet`;

function octokitFor() {
  const posted = [];
  const request = jest.fn((route, params) => {
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
      if (params.mediaType?.format === 'diff') {
        return Promise.resolve({ data: 'diff --git a/x.rs b/x.rs\n+++ b/x.rs\n@@ -1 +1 @@\n+x\n' });
      }
      return Promise.resolve({
        data: {
          number: 7, title: 't', body: '', user: { login: 'dev' },
          base: { ref: 'main', sha: 'base000', repo: { full_name: 'org/r' } },
          head: { ref: 'f', sha: 'head111', repo: { full_name: 'fork/r' } }
        }
      });
    }
    if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/files') {
      return Promise.resolve({ data: [{ filename: 'x.rs', additions: 1, deletions: 1 }] });
    }
    if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
      posted.push(params.body);
      return Promise.resolve({ status: 201, data: {} });
    }
    return Promise.resolve({ status: 200, data: [] });
  });
  return { request, posted };
}

const finding = {
  source: 'oracle:rivet-validate', severity: 'error', artifact_id: 'REQ-1',
  message: 'broken link', claim: 'REQ-1: broken link'
};

beforeEach(() => {
  global.fetch = jest.fn(() => { throw new Error('the model must not be called'); });
  _setConfigForTesting({ ai_review: { enabled: false }, rivet_oracle: ORACLE });
  runRivetOracle.mockResolvedValue({ ok: true, applicable: true, findings: [finding] });
  resolvePinnedRivet.mockImplementation(async ({ pin: p }) => ({ ok: true, binary: bin(p.layer) }));
});

afterEach(() => {
  _reviewTimestamps.clear();
  _resetReviews();
  _setConfigForTesting({});
  jest.clearAllMocks();
});

describe('per-repo rivet', () => {
  it('runs the head pin\'s rivet on head and the base pin\'s rivet on base', async () => {
    repoVarvePin.mockImplementation(async (o, owner, repo, sha) =>
      sha === 'head111' ? pin('2026.11.16') : pin('2026.11.10'));
    const gh = octokitFor();
    const r = await reviewPullRequest(gh, 'org', 'r', 7);
    expect(r.success).toBe(true);
    expect(runRivetOracle.mock.calls[0][0]).toBe(bin('2026.11.16'));
    expect(runRivetValidate.mock.calls[0][0]).toBe(bin('2026.11.10'));
    // The pin is read from the PR's own repository at each commit, and varve
    // is given only the deploy's realms file, varve and store.
    expect(repoVarvePin.mock.calls.map((c) => c[3]).sort()).toEqual(['base000', 'head111']);
    for (const [arg] of resolvePinnedRivet.mock.calls) {
      expect(arg).toMatchObject({
        varveBinary: ORACLE.varve_binary,
        storesDir: ORACLE.stores_dir,
        pinsDir: ORACLE.pins_dir,
        realmsFile: ORACLE.realms_file
      });
    }
    // The single-binary version probe is not the gate in this mode.
    expect(rivetBinaryVersion).not.toHaveBeenCalled();
    expect(gh.posted[0]).toContain('REQ-1');
  });

  it.each([
    ['a realm the deploy does not trust', pin('2026.11.16', 'attacker'), /realm attacker is not in rivet_oracle.realms_allowed/],
    ['a layer string that is a path', pin('../../../tmp/evil'), /no valid layer/],
    ['no varve.toml', null, /pins no varve layer/]
  ])('%s: skipped, nothing resolved or run, the log names the repo', async (_, headPin, reason) => {
    repoVarvePin.mockResolvedValue(headPin);
    const gh = octokitFor();
    const r = await reviewPullRequest(gh, 'org', 'r', 7);
    expect(resolvePinnedRivet).not.toHaveBeenCalled();
    expect(runRivetOracle).not.toHaveBeenCalled();
    expect(gh.posted).toHaveLength(0);
    expect(r).toMatchObject({ success: true, skipped: true });
    const skip = getLogger().info.mock.calls.find((c) => /Rivet oracle skipped/.test(c[1]));
    expect(skip[0]).toMatchObject({ repo: 'org/r', pr: 7 });
    expect(skip[0].reason).toMatch(reason);
  });

  it('a layer the host has not installed is a skip with the layer named', async () => {
    repoVarvePin.mockResolvedValue(pin('2026.11.23'));
    resolvePinnedRivet.mockResolvedValue({ ok: false, reason: 'layer pulseengine/2026.11.23 is not installed on this host' });
    const gh = octokitFor();
    await reviewPullRequest(gh, 'org', 'r', 7);
    expect(runRivetOracle).not.toHaveBeenCalled();
    const skip = getLogger().info.mock.calls.find((c) => /Rivet oracle skipped/.test(c[1]));
    expect(skip[0]).toMatchObject({ repo: 'org/r', layer: 'pulseengine/2026.11.23' });
  });

  it('a base that cannot be resolved leaves the oracle head-only, with a warning', async () => {
    repoVarvePin.mockImplementation(async (o, owner, repo, sha) =>
      sha === 'head111' ? pin('2026.11.16') : null);
    const gh = octokitFor();
    const r = await reviewPullRequest(gh, 'org', 'r', 7);
    expect(r.success).toBe(true);
    expect(runRivetOracle).toHaveBeenCalledTimes(1);
    expect(runRivetValidate).not.toHaveBeenCalled();
    expect(getLogger().warn.mock.calls.some((c) => /head-only/.test(c[1]) && c[0].repo === 'org/r')).toBe(true);
  });
});

describe('oracle failures name the repo and layer', () => {
  it('logs repo and layer when the head oracle or base validate throws', async () => {
    repoVarvePin.mockImplementation(async (o, owner, repo, sha) =>
      sha === 'head111' ? pin('2026.11.16', 'covalent') : pin('2026.11.10', 'covalent'));
    runRivetValidate.mockRejectedValueOnce(new Error('base boom'));
    runRivetOracle.mockRejectedValueOnce(new Error('head boom'));
    await reviewPullRequest(octokitFor(), 'org', 'r', 7);
    const warns = getLogger().warn.mock.calls;
    const base = warns.find((c) => /base-ref validate failed/.test(c[1]));
    const head = warns.find((c) => /Rivet oracle failed/.test(c[1]));
    expect(base[0]).toMatchObject({ repo: 'org/r', layer: 'covalent/2026.11.10', err: 'base boom' });
    expect(head[0]).toMatchObject({ repo: 'org/r', layer: 'covalent/2026.11.16', err: 'head boom' });
  });
});

describe('reviewStatus in per-repo mode', () => {
  it('reports the oracle on, per-repo, with the trusted realms', () => {
    expect(reviewStatus({ ai_review: { enabled: false }, rivet_oracle: ORACLE }).oracle).toEqual({
      state: 'on', rivet: 'per-repo pin', realms: ['pulseengine', 'covalent']
    });
  });
});
