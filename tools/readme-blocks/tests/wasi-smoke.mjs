// Runs the wasm32-wasip1 build under node:wasi, the way temper will load it,
// and checks its answers. Usage: node wasi-smoke.mjs <module.wasm> <repo root>
import { WASI } from 'node:wasi';
import { readFile, mkdtemp, writeFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const [wasmPath, root] = process.argv.slice(2);
const mod = await WebAssembly.compile(await readFile(wasmPath));

async function run(dir, args) {
  const out = join(dir, 'stdout');
  await writeFile(out, '');
  const { openSync, closeSync, readFileSync } = await import('node:fs');
  const fd = openSync(out, 'w');
  const wasi = new WASI({
    version: 'preview1', args: ['readme-blocks', ...args], env: {},
    preopens: { '/work': dir }, stdout: fd, returnOnExit: true,
  });
  const inst = await WebAssembly.instantiate(mod, wasi.getImportObject());
  const rc = wasi.start(inst);
  closeSync(fd);
  return { rc, stdout: readFileSync(out, 'utf8') };
}

const dir = await mkdtemp(join(tmpdir(), 'readme-blocks-'));
await cp(join(root, 'templates/readme'), join(dir, 't'), { recursive: true });
await writeFile(join(dir, 'vars.yaml'),
  'format: 1\nname: zwinger\none_liner: "Confines an agent."\nstatus: active\nlicence: MIT\n');
await writeFile(join(dir, 'README.md'),
  'x\n<!-- pulseengine:licence -->\nold\n<!-- /pulseengine:licence -->\n');

const iv = await run(dir, ['interface-version']);
assert.equal(iv.rc, 0);
assert.equal(iv.stdout.trim(), '1');

const check = ['check', '--format', 'json', '--variables', '/work/vars.yaml',
  '--readme', '/work/README.md', '--templates', '/work/t'];
const drift = await run(dir, check);
assert.equal(drift.rc, 0);
const j = JSON.parse(drift.stdout);
assert.equal(j.interface, 1);
assert.equal(j.code, 'divergent_undeclared');
assert.equal(j.readme,
  'x\n<!-- pulseengine:licence -->\nMIT. Issues and pull requests are welcome.\n<!-- /pulseengine:licence -->\n');

await writeFile(join(dir, 'README.md'), j.readme);
const ok = await run(dir, check);
assert.equal(JSON.parse(ok.stdout).code, 'ok');

// A path outside the preopen is unreadable: exit 1, nothing on stdout.
const outside = await run(dir, ['check', '--format', 'json', '--variables', '/etc/hosts',
  '--readme', '/work/README.md', '--templates', '/work/t']);
assert.equal(outside.rc, 1);
assert.equal(outside.stdout, '');
console.log('wasi smoke: 4 runs ok');
