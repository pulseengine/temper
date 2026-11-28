// temper's own loader (src/readme-blocks.js) against a real wasm32-wasip1
// build: the sha256 gate, the interface-version gate and checkReadme.
// Usage: node loader-smoke.mjs <module.wasm> <repo root>
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const [wasm, root] = process.argv.slice(2);
const { loadModule, checkReadme, TEMPLATES_DIR } = await import(pathToFileURL(path.join(root, 'src/readme-blocks.js')));
const sha = crypto.createHash('sha256').update(fs.readFileSync(wasm)).digest('hex');

assert.throws(() => loadModule({ modulePath: wasm, moduleSha256: '0'.repeat(64) }), /module sha256 .* is not the configured/);
const mod = loadModule({ modulePath: wasm, moduleSha256: sha });

const variables = 'format: 1\nname: zwinger\none_liner: "Confines an agent."\nstatus: active\nlicence: MIT\n';
const synced = 'x\n<!-- pulseengine:licence -->\nMIT. Issues and pull requests are welcome.\n<!-- /pulseengine:licence -->\n';
const drift = checkReadme(mod, { variables, readme: synced.replace('MIT. Issues', 'old') }, TEMPLATES_DIR);
assert.equal(drift.code, 'divergent_undeclared');
assert.equal(drift.readme, synced);
assert.equal(checkReadme(mod, { variables, readme: synced }, TEMPLATES_DIR).code, 'ok');
assert.equal(checkReadme(mod, { variables, readme: 'no markers\n' }, TEMPLATES_DIR).code, 'not_applicable');
assert.throws(() => checkReadme(mod, { variables: 'format: 1\nbogus: 1\n', readme: synced }, '/nonexistent'), /ENOENT|module exit/);
console.log('loader smoke: 6 checks ok');
