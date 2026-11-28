import { ciConcurrency, cancelMode, workflowFindings } from '../../src/concurrency.js';
import yaml from 'js-yaml';

const KAPSEL = "concurrency:\n  group: ${{ github.workflow }}-${{ github.ref }}\n  cancel-in-progress: ${{ github.event_name == 'pull_request' }}\n";
const JOBS = 'jobs:\n  build:\n    runs-on: ubuntu-24.04\n    steps: [{run: "true"}]\n';

const wf = (path, text) => ({ path: `.github/workflows/${path}`, text });
function snap(files, { status = 200, unread = [], branch = 'main' } = {}) {
  return {
    repo: { status: 200, body: { default_branch: branch } },
    workflows: { status },
    workflowTexts: files,
    workflowUnread: unread
  };
}
const code = (s) => ciConcurrency(s).check.code;

describe('cancelMode', () => {
  it.each([
    [undefined, 'none'],
    ['ci-${{ github.ref }}', 'never'],
    [{ group: 'g' }, 'never'],
    [{ group: 'g', 'cancel-in-progress': false }, 'never'],
    [{ group: 'g', 'cancel-in-progress': true }, 'always'],
    [{ group: 'g', 'cancel-in-progress': "${{ github.event_name == 'pull_request' }}" }, 'pr_only'],
    [{ group: 'g', 'cancel-in-progress': "${{ github.event_name != 'push' }}" }, 'pr_only'],
    [{ group: 'g', 'cancel-in-progress': '${{ inputs.cancel }}' }, 'maybe']
  ])('%j -> %s', (c, m) => expect(cancelMode(c)).toBe(m));
});

describe('ci.concurrency', () => {
  it('kapsel\'s form on a PR + main workflow is ok', () => {
    expect(code(snap([wf('ci.yml', `on: [pull_request, push]\n${KAPSEL}${JOBS}`)]))).toBe('ok');
  });

  describe('pr_not_cancelled', () => {
    it('a PR workflow without concurrency', () => {
      const r = ciConcurrency(snap([wf('ci.yml', `on: pull_request\n${JOBS}`)]));
      expect(r.check).toEqual({ id: 'ci.concurrency', ok: false, severity: 'medium', code: 'pr_not_cancelled' });
      expect(r.findings).toEqual([{ path: '.github/workflows/ci.yml', code: 'pr_not_cancelled' }]);
    });
    it('a group that is not ref-scoped (one PR would cancel another)', () => {
      expect(code(snap([wf('ci.yml', `on: pull_request\nconcurrency: {group: ci, cancel-in-progress: true}\n${JOBS}`)]))).toBe('pr_not_cancelled');
    });
    it('a ref-scoped group that never cancels', () => {
      expect(code(snap([wf('ci.yml', `on: pull_request\nconcurrency: ci-\${{ github.ref }}\n${JOBS}`)]))).toBe('pr_not_cancelled');
    });
    it('negative control: a PR-only workflow with cancel-in-progress: true is ok', () => {
      expect(code(snap([wf('ci.yml', `on: pull_request\nconcurrency: {group: "ci-\${{ github.head_ref }}", cancel-in-progress: true}\n${JOBS}`)]))).toBe('ok');
    });
    it('job-level: every job ref-scoped and cancelling is ok', () => {
      const text = "on: pull_request\njobs:\n  a:\n    runs-on: x\n    concurrency: {group: \"a-${{ github.ref }}\", cancel-in-progress: true}\n    steps: [{run: 'true'}]\n  b:\n    runs-on: x\n    concurrency: {group: \"b-${{ github.ref }}\", cancel-in-progress: \"${{ github.event_name == 'pull_request' }}\"}\n    steps: [{run: 'true'}]\n";
      expect(code(snap([wf('ci.yml', text)]))).toBe('ok');
    });
    it('job-level: one job without concurrency is pr_not_cancelled', () => {
      const text = "on: pull_request\njobs:\n  a:\n    runs-on: x\n    concurrency: {group: \"a-${{ github.ref }}\", cancel-in-progress: true}\n    steps: [{run: 'true'}]\n  b:\n    runs-on: x\n    steps: [{run: 'true'}]\n";
      expect(code(snap([wf('ci.yml', text)]))).toBe('pr_not_cancelled');
    });
  });

  describe('main_cancellable', () => {
    it('cancel-in-progress: true on a workflow that also runs on push to main', () => {
      expect(code(snap([wf('ci.yml', `on: [pull_request, push]\nconcurrency: {group: "ci-\${{ github.ref }}", cancel-in-progress: true}\n${JOBS}`)]))).toBe('main_cancellable');
    });
    it('on merge_group', () => {
      expect(code(snap([wf('ci.yml', `on: [pull_request, merge_group]\nconcurrency: {group: "ci-\${{ github.ref }}", cancel-in-progress: true}\n${JOBS}`)]))).toBe('main_cancellable');
    });
    it('on a job of a push workflow', () => {
      const text = "on:\n  push:\n    branches: [main]\njobs:\n  a:\n    runs-on: x\n    concurrency: {group: g, cancel-in-progress: true}\n    steps: [{run: 'true'}]\n";
      expect(code(snap([wf('ci.yml', text)]))).toBe('main_cancellable');
    });
    it('negative control: push to another branch only is ok', () => {
      const text = `on:\n  push:\n    branches: [gh-pages]\nconcurrency: {group: pages, cancel-in-progress: true}\n${JOBS}`;
      expect(code(snap([wf('pages.yml', text)]))).toBe('ok');
    });
    it('uses the repo\'s default branch, not "main"', () => {
      const text = `on:\n  push:\n    branches: [trunk]\nconcurrency: {group: g, cancel-in-progress: true}\n${JOBS}`;
      expect(code(snap([wf('ci.yml', text)], { branch: 'trunk' }))).toBe('main_cancellable');
      expect(code(snap([wf('ci.yml', text)], { branch: 'main' }))).toBe('ok');
    });
  });

  describe('release_cancellable', () => {
    it('a tag-push workflow with cancel-in-progress: true', () => {
      const text = `on:\n  push:\n    tags: ['v*']\nconcurrency: {group: release, cancel-in-progress: true}\n${JOBS}`;
      expect(code(snap([wf('release.yml', text)]))).toBe('release_cancellable');
    });
    it('a release event with a non-literal expression (may cancel)', () => {
      const text = `on:\n  release:\n    types: [published]\nconcurrency: {group: r, cancel-in-progress: "\${{ inputs.x }}"}\n${JOBS}`;
      expect(code(snap([wf('publish.yml', text)]))).toBe('release_cancellable');
    });
    it('a release-named dispatch workflow', () => {
      const text = `name: Release\non: workflow_dispatch\nconcurrency: {group: r, cancel-in-progress: true}\n${JOBS}`;
      expect(code(snap([wf('cut.yml', text)]))).toBe('release_cancellable');
    });
    it('outranks the other findings', () => {
      expect(code(snap([
        wf('ci.yml', `on: pull_request\n${JOBS}`),
        wf('release.yml', `on:\n  push:\n    tags: ['v*']\nconcurrency: {group: r, cancel-in-progress: true}\n${JOBS}`)
      ]))).toBe('release_cancellable');
    });
    it('negative control: a tag workflow with cancel-in-progress: false is ok', () => {
      const text = `on:\n  push:\n    tags: ['v*']\nconcurrency: {group: release, cancel-in-progress: false}\n${JOBS}`;
      expect(code(snap([wf('release.yml', text)]))).toBe('ok');
    });
    it('negative control: a PR-only expression cannot cancel a tag run', () => {
      const text = `on:\n  pull_request:\n  push:\n    tags: ['v*']\n${KAPSEL}${JOBS}`;
      expect(code(snap([wf('release.yml', text)]))).toBe('ok');
    });
  });

  describe('error_parse', () => {
    it('a file that does not parse, with the denominator', () => {
      const r = ciConcurrency(snap([wf('ok.yml', `on: push\n${JOBS}`), wf('bad.yml', 'on: [push\njobs: {')]));
      expect(r.check).toEqual({ id: 'ci.concurrency', ok: false, severity: 'medium', code: 'error_parse' });
      expect([r.parsed, r.total]).toEqual([1, 2]);
    });
    it('a file without jobs counts as unparsed', () => {
      expect(code(snap([wf('x.yml', 'name: nothing\n')]))).toBe('error_parse');
    });
    it('ranks below a finding', () => {
      expect(code(snap([wf('ci.yml', `on: pull_request\n${JOBS}`), wf('bad.yml', ': : :')]))).toBe('pr_not_cancelled');
    });
    it('negative control: the same repo with the file fixed is ok', () => {
      expect(code(snap([wf('ok.yml', `on: push\n${JOBS}`), wf('bad.yml', `on: push\n${JOBS}`)]))).toBe('ok');
    });
  });

  describe('read errors and not_applicable', () => {
    it('no workflows directory is not_applicable', () => {
      expect(ciConcurrency(snap([], { status: 404 })).check).toEqual({ id: 'ci.concurrency', ok: true, severity: 'medium', code: 'not_applicable' });
    });
    it('an empty directory is not_applicable', () => {
      expect(code(snap([]))).toBe('not_applicable');
    });
    it('an unreadable directory is undecided', () => {
      expect(ciConcurrency(snap([], { status: 500 })).check).toEqual({ id: 'ci.concurrency', ok: null, severity: 'medium', code: 'error_api' });
      expect(code(snap([], { status: 403 }))).toBe('error_permission');
    });
    it('an unread file is never ok: the repo was not fully read', () => {
      const r = ciConcurrency(snap([wf('ci.yml', `on: push\n${JOBS}`)], { unread: [{ path: '.github/workflows/x.yml', status: 502 }] }));
      expect(r.check.code).toBe('error_api');
      expect(r.total).toBe(2);
    });
    it('a snapshot without workflow texts (older cache) yields no check', () => {
      expect(ciConcurrency({ workflows: { status: 200 } })).toBeNull();
    });
  });

  it('workflowFindings returns every finding for one workflow', () => {
    const doc = yaml.load(`on:\n  pull_request:\n  push:\n    branches: [main]\n    tags: ['v*']\nconcurrency: {group: g, cancel-in-progress: true}\n${JOBS}`);
    expect(workflowFindings({ path: 'release.yml', doc }).sort()).toEqual(['main_cancellable', 'pr_not_cancelled', 'release_cancellable']);
  });
});
