// AI-review evaluation runner (temper#92). Eval-only, not shipped.
// Calls temper's own production functions (buildReviewPrompt, callLocalAI,
// tryParseReview, filterFindings) so what is measured is what temper sends.
//
// usage: node run.mjs <model> <full|trimmed> [pr-folder ...]   (from eval/review-bench)
//   env: TEMPER (temper checkout), ENDPOINT (default local ollama), OUT (runs dir)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TEMPER = process.env.TEMPER || path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const ENDPOINT = process.env.ENDPOINT || 'http://127.0.0.1:11434/v1/chat/completions';
const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = process.env.OUT || path.join(HERE, 'runs');

const rv = await import(path.join(TEMPER, 'src/ai-review.js'));
const pr = await import(path.join(TEMPER, 'src/ai-review-prompt.js'));

export const CLASSES = ['logic', 'error-handling', 'security', 'concurrency', 'resource',
  'api-contract', 'test-gap', 'vacuous-check', 'config-ci', 'docs-mismatch'];

const SYSTEM = pr.STRICT_SYSTEM_PROMPT.replace(
  '\n\nSchema:',
  `\n9. Each finding has a "class", exactly one of: ${CLASSES.join(', ')}. ` +
  '"vacuous-check" means a test or CI gate that cannot fail.\n\nSchema:'
).replace('"claim": "<concrete falsifiable assertion, max 200 chars>"',
  `"claim": "<concrete falsifiable assertion, max 200 chars>",\n      "class": "<one of the classes in rule 9>"`);

function schema() {
  const s = structuredClone(pr.REVIEW_JSON_SCHEMA);
  const item = s.properties.findings.items;
  item.properties.class = { type: 'string', enum: CLASSES };
  item.required = [...item.required, 'class'];
  return { type: 'json_schema', json_schema: { name: 'PullRequestReview', strict: true, schema: s } };
}

// ── trimmed variant (PREREG "Variants") ──────────────────────────────────
function dropFile(f) {
  const lower = f.filename.toLowerCase();
  const base = lower.split('/').pop();
  if (rv.classifyFile(f.filename).tier === 0) return true;
  if (base.endsWith('.md') || base.endsWith('.txt') || base.startsWith('license')) return true;
  if (/^Binary files /m.test(f.diff) || /^GIT binary patch/m.test(f.diff)) return true;
  if (/^rename from /m.test(f.diff) && !/^@@ /m.test(f.diff)) return true;
  if (lower.startsWith('artifacts/') && (base.endsWith('.yaml') || base.endsWith('.yml'))) return true;
  return false;
}

function category(name) {
  const lower = name.toLowerCase();
  const { tier } = rv.classifyFile(name);
  const shellish = lower.endsWith('.sh') || lower.endsWith('.bash');
  const ciish = lower.startsWith('.github/workflows/') || lower.includes('ansible') ||
    lower.includes('/roles/') || lower.includes('playbook') || shellish;
  if (tier === 1 && !shellish) return 0;
  if (ciish) return 1;
  if (tier === 2) return 2;
  return 3;
}

// Re-cut one hunk to 1 line of context around changes; returns sub-hunks.
function recut(header, lines) {
  const m = header.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
  if (!m) return [];
  let oldNo = +m[1], newNo = +m[2];
  const rows = lines.map((l) => {
    const t = l[0] === '+' || l[0] === '-' ? l[0] : ' ';
    const r = { t, l, old: oldNo, new: newNo };
    if (t !== '+') oldNo++;
    if (t !== '-') newNo++;
    return r;
  });
  const keep = rows.map((r, i) =>
    r.t !== ' ' || rows[i - 1]?.t && rows[i - 1].t !== ' ' || rows[i + 1]?.t && rows[i + 1].t !== ' ');
  const out = [];
  let cur = null;
  rows.forEach((r, i) => {
    if (!keep[i]) { cur = null; return; }
    if (!cur) { cur = { old: r.old, new: r.new, rows: [] }; out.push(cur); }
    cur.rows.push(r);
  });
  return out.map((h) => {
    const oc = h.rows.filter((r) => r.t !== '+').length;
    const nc = h.rows.filter((r) => r.t !== '-').length;
    return `@@ -${h.old},${oc} +${h.new},${nc} @@${m[3]}\n` + h.rows.map((r) => r.l).join('\n');
  });
}

export function trimDiff(diff, budget = 6000) {
  const files = rv.parseDiffByFile(diff).filter((f) => !dropFile(f));
  const units = [];
  for (const f of files) {
    const at = f.diff.search(/^@@ /m);
    if (at < 0) continue;
    const head = f.diff.slice(0, at).trimEnd();
    const body = f.diff.slice(at).split('\n');
    let h = null, acc = [];
    const flush = () => { if (h) for (const s of recut(h, acc)) units.push({ file: f.filename, head, cat: category(f.filename), text: s }); };
    for (const l of body) {
      if (l.startsWith('@@ ')) { flush(); h = l; acc = []; } else if (h && l !== '\\ No newline at end of file') acc.push(l);
    }
    flush();
  }
  units.sort((a, b) => a.cat - b.cat); // stable: file order kept within a category
  let left = budget;
  const chosen = new Map();
  for (const u of units) {
    const cost = u.text.length + (chosen.has(u.file) ? 0 : u.head.length + 1);
    if (cost > left) continue;
    left -= cost;
    if (!chosen.has(u.file)) chosen.set(u.file, { head: u.head, hunks: [] });
    chosen.get(u.file).hunks.push(u.text);
  }
  return [...chosen.values()].map((c) => `${c.head}\n${c.hunks.join('\n')}`).join('\n');
}

// ── one run ──────────────────────────────────────────────────────────────
export function buildRequest(variant, folder) {
  const dir = path.join(HERE, 'prs', folder);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const diff = fs.readFileSync(path.join(dir, 'diff.patch'), 'utf8');
  const prData = {
    number: meta.number, title: meta.title, body: meta.body,
    user: { login: meta.author?.login || 'unknown' },
    base: { ref: meta.baseRefName }, head: { ref: meta.headRefName },
  };
  const files = (meta.files || []).map((f) => ({ filename: f.path, additions: f.additions, deletions: f.deletions }));
  const shown = variant === 'trimmed' ? trimDiff(diff) : diff;
  const user = variant === 'trimmed'
    ? rv.buildReviewPrompt(prData, shown, files, Number.MAX_SAFE_INTEGER)
    : rv.buildReviewPrompt(prData, diff, files, 12000);
  return { user, shown };
}

export const SYSTEM_PROMPT = SYSTEM;
export const responseFormat = schema;

async function runOne(model, variant, folder) {
  const { user, shown } = buildRequest(variant, folder);
  const rec = { pr: folder, model, variant, prompt_chars: user.length + SYSTEM.length, ok: false,
    error: null, latency_ms: null, raw_findings: 0, kept: [], dropped: 0, raw: null };
  const LOG = process.env.OLLAMA_LOG || path.join(os.homedir(), 'Library/Logs/ollama.log');
  const logAt = fs.existsSync(LOG) ? fs.statSync(LOG).size : null;
  const t0 = Date.now();
  try {
    const raw = await rv.callLocalAI(ENDPOINT, model, SYSTEM, user,
      { temperature: 0, maxTokens: 2000, timeout: 600000, responseFormat: process.env.NO_RF ? undefined : schema() });
    rec.latency_ms = Date.now() - t0;
    rec.raw = raw;
    const parsed = pr.tryParseReview(raw);
    if (!parsed.ok) {
      rec.error = parsed.error;
    } else {
      rec.ok = true;
      rec.raw_findings = parsed.data.findings.length;
      // quote-or-die against what the model was shown, as production does
      rec.kept = pr.filterFindings(parsed.data.findings, shown);
      rec.dropped = rec.raw_findings - rec.kept.length;
    }
  } catch (e) {
    rec.latency_ms = Date.now() - t0;
    rec.error = String(e.message || e);
  }
  // Ollama's own record of this request: prompt tokens, context, truncation.
  if (logAt !== null) {
    const fd = fs.openSync(LOG, 'r');
    const len = fs.statSync(LOG).size - logAt;
    const buf = Buffer.alloc(Math.max(0, len));
    fs.readSync(fd, buf, 0, buf.length, logAt);
    fs.closeSync(fd);
    const log = buf.toString('utf8');
    const ctx = [...log.matchAll(/n_ctx_slot = (\d+)/g)].map((x) => +x[1]);
    const ntok = [...log.matchAll(/new prompt, .*?task\.n_tokens = (\d+)/g)].map((x) => +x[1]);
    const trunc = [...log.matchAll(/truncated = (\d)/g)].map((x) => +x[1]);
    rec.ollama = { n_ctx: ctx.at(-1) ?? null, prompt_tokens: ntok.at(-1) ?? null,
      truncated: /truncating input prompt/.test(log) || (trunc.length ? trunc.some((t) => t === 1) : null),
      ollama_cut: (log.match(/truncating input prompt.*?prompt=(\d+).*?new=(\d+)/) || []).slice(1).map(Number) };
  }
  const out = path.join(OUT, model.replace(/[^A-Za-z0-9._-]/g, '_'), variant);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, `${folder}.json`), JSON.stringify(rec, null, 1));
  return rec;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [model, variant, ...only] = process.argv.slice(2);
  if (!model || !['full', 'trimmed'].includes(variant)) {
    console.error('usage: node run.mjs <model> <full|trimmed> [pr-folder ...]');
    process.exit(2);
  }
  const folders = only.length ? only : fs.readdirSync(path.join(HERE, 'prs')).filter((d) =>
    fs.existsSync(path.join(HERE, 'prs', d, 'diff.patch'))).sort();
  for (const f of folders) {
    const r = await runOne(model, variant, f);
    console.log(`${model} ${variant} ${f}: ok=${r.ok} kept=${r.kept.length}/${r.raw_findings} ${r.latency_ms} ms ${r.prompt_chars} chars${r.error ? ' ' + r.error : ''}`);
  }
}
