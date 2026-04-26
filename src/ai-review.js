import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getConfig } from './config.js';
import { getLogger } from './logger.js';
import {
  STRICT_SYSTEM_PROMPT,
  tryParseReview,
  filterFindings,
  computeVerdict,
  renderReviewMarkdown
} from './ai-review-prompt.js';
import { runRivetOracle } from './rivet-oracle.js';
import { hasRivetYaml, withTempRepoCheckout } from './rivet-fetch.js';

const _reviewTimestamps = new Map();

/** @type {{has, get, set, sweep}|null} optional SQLite-backed KV store for rate limits */
let _rateLimitStore = null;

/**
 * Swap in a persistent KV store (SQLite). Calling with `null` reverts to
 * in-memory behaviour. The caller owns the lifecycle of the store.
 */
export function setRateLimitStore(store) {
  _rateLimitStore = store;
}

const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

function isRateLimited(key) {
  if (_rateLimitStore) {
    return _rateLimitStore.has(key);
  }
  const last = _reviewTimestamps.get(key);
  return !!(last && Date.now() - last < RATE_LIMIT_WINDOW_MS);
}

function recordReview(key) {
  if (_rateLimitStore) {
    _rateLimitStore.set(key, '1', { ttl: RATE_LIMIT_WINDOW_MS });
    return;
  }
  _reviewTimestamps.set(key, Date.now());
}

function isLocalEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname;
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

function sanitizeAIOutput(text) {
  // Strip GitHub Actions workflow commands that could be injected
  return text.replace(/::[\w-]+(\s+[\w-]+=[\w-]+)*::.*/g, '[sanitized command]');
}

/**
 * Split a monolithic unified diff into per-file segments.
 * @param {string} unifiedDiff
 * @returns {Array<{filename: string, diff: string, size: number}>}
 */
function parseDiffByFile(unifiedDiff) {
  if (!unifiedDiff || typeof unifiedDiff !== 'string') return [];

  const files = [];
  // Split on diff headers, keeping the header with its segment
  const segments = unifiedDiff.split(/(?=^diff --git )/m);

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    // Extract filename from "diff --git a/path b/path"
    const headerMatch = trimmed.match(/^diff --git a\/(.+?) b\/(.+)/m);
    if (!headerMatch) continue;

    // Use the b/ path (destination) as the filename (handles renames)
    const filename = headerMatch[2];
    files.push({ filename, diff: trimmed, size: trimmed.length });
  }

  return files;
}

/**
 * Classify a file into a priority tier.
 * @param {string} filename
 * @returns {{tier: number, label: string}}
 *
 * Tier 0 = skip (lockfiles, generated, vendored)
 * Tier 1 = source code
 * Tier 2 = tests (checked before source since test files have source extensions)
 * Tier 3 = config / docs
 */
function classifyFile(filename) {
  const lower = filename.toLowerCase();
  const base = lower.split('/').pop();

  // Tier 0: skip — lockfiles, generated, vendored, minified
  if (
    base.endsWith('.lock') ||
    base === 'go.sum' ||
    base === 'go.work.sum' ||
    base === 'package-lock.json' ||
    base === 'yarn.lock' ||
    base === 'pnpm-lock.yaml' ||
    base === 'composer.lock' ||
    base === 'gemfile.lock' ||
    base === 'poetry.lock' ||
    base === 'pipfile.lock' ||
    base.endsWith('.min.js') ||
    base.endsWith('.min.css') ||
    lower.includes('.generated.') ||
    lower.includes('.pb.go') ||
    lower.startsWith('vendor/') ||
    lower.includes('/vendor/') ||
    base === 'module.bazel.lock'
  ) {
    return { tier: 0, label: 'skipped: lockfile/generated' };
  }

  // Tier 2: tests — check before source since test files have source extensions
  if (
    base.includes('test') ||
    base.includes('spec') ||
    lower.includes('__tests__/') ||
    lower.startsWith('__tests__/')
  ) {
    return { tier: 2, label: 'test' };
  }

  // Tier 1: source code
  const sourceExts = [
    '.rs', '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.v', '.c', '.cpp',
    '.cc', '.h', '.hpp', '.java', '.kt', '.kts', '.swift', '.rb', '.ex',
    '.exs', '.zig', '.nim', '.cs', '.fs', '.scala', '.lua', '.sh', '.bash',
    '.zsh', '.fish', '.pl', '.pm', '.r', '.jl', '.dart', '.vue', '.svelte'
  ];
  const ext = '.' + base.split('.').pop();
  if (sourceExts.includes(ext)) {
    return { tier: 1, label: 'source' };
  }

  // Tier 3: config / docs
  return { tier: 3, label: 'config/docs' };
}

/**
 * Sort file diffs by priority: tier ascending, then size ascending within tier.
 * @param {Array<{filename: string, diff: string, size: number}>} fileDiffs
 * @returns {Array<{filename: string, diff: string, size: number, tier: number, label: string}>}
 */
function prioritizeFiles(fileDiffs) {
  return fileDiffs
    .map((f) => {
      const { tier, label } = classifyFile(f.filename);
      return { ...f, tier, label };
    })
    .sort((a, b) => a.tier - b.tier || a.size - b.size);
}

function buildReviewPrompt(prData, diff, files, maxDiffSize) {
  // Phase 1 — File manifest (always complete, even for skipped files)
  const fileDiffs = parseDiffByFile(typeof diff === 'string' ? diff : '');
  const prioritized = prioritizeFiles(fileDiffs);

  // Build manifest from GitHub file list, annotated with tier info
  const classifiedMap = new Map(prioritized.map((f) => [f.filename, f]));
  const fileList = files
    .map((f) => {
      const classified = classifiedMap.get(f.filename);
      const label = classified ? classified.label : 'config/docs';
      return `- \`${f.filename}\` (+${f.additions}/-${f.deletions}) [${label}]`;
    })
    .join('\n');

  // Phase 2 — Prioritized diffs within budget
  let budget = maxDiffSize;
  let filesShown = 0;
  let filesOmitted = 0;
  const includedDiffs = [];

  for (const file of prioritized) {
    if (file.tier === 0) {
      filesOmitted++;
      continue;
    }
    if (file.size <= budget) {
      includedDiffs.push(file.diff);
      budget -= file.size;
      filesShown++;
    } else {
      filesOmitted++;
    }
  }

  const totalFiles = prioritized.length;
  const diffHeader =
    totalFiles > 0
      ? `Diff (${filesShown} of ${totalFiles} files shown, ${filesOmitted} omitted for size/type)`
      : 'Diff';

  const diffContent = includedDiffs.join('\n\n');

  return (
    `## Pull Request #${prData.number}: ${prData.title}\n\n` +
    `**Author:** ${prData.user.login}\n` +
    `**Base:** ${prData.base.ref} ← ${prData.head.ref}\n` +
    `**Files changed:**\n${fileList}\n\n` +
    `**Description:**\n${prData.body || '(no description)'}\n\n` +
    `**${diffHeader}:**\n\`\`\`diff\n${diffContent}\n\`\`\``
  );
}

async function callLocalAI(endpoint, model, systemPrompt, userPrompt, options = {}) {
  const { maxTokens = 2000, temperature = 0.3, timeout = 300000 } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        max_tokens: maxTokens,
        temperature,
        stream: false
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`AI endpoint returned ${response.status}: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

const AI_REVIEW_SIGNATURE = 'AI Code Review';

function formatReviewComment(aiResponse, prNumber, headSha, meta) {
  const sanitized = sanitizeAIOutput(aiResponse);

  let header = `## ${AI_REVIEW_SIGNATURE} for PR #${prNumber}\n`;
  if (meta) {
    const base = meta.baseRepo && meta.baseBranch
      ? `${meta.baseRepo}:\`${meta.baseBranch}\``
      : meta.baseBranch ? `\`${meta.baseBranch}\`` : '';
    const head = meta.headRepo && meta.headBranch
      ? `${meta.headRepo}:\`${meta.headBranch}\``
      : meta.headBranch ? `\`${meta.headBranch}\`` : '';
    if (base && head) header += `${head} → ${base}\n`;
  }

  let footer =
    '*This review was generated by a local AI model. ' +
    'It is advisory only and may contain inaccuracies.*';

  if (headSha) {
    footer += `\n\n*Reviewed at \`${headSha.substring(0, 7)}\`*`;
  }

  return (
    header + '\n' +
    sanitized +
    '\n\n---\n' +
    footer
  );
}

/**
 * Mark previous bot reviews as outdated before posting a new one.
 * Edits old comment bodies to prepend an "Outdated" warning.
 */
async function supersedePreviousReviews(octokit, owner, repo, prNumber) {
  try {
    // Use octokit.request() form (not .issues.listComments) because Probot v14's
    // bundled Octokit does not always expose the .issues namespace plugin in the
    // pull_request.opened event context \u2014 that mismatch was silently breaking
    // every auto AI review with "Cannot read properties of undefined".
    const { data: comments } = await octokit.request(
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { owner, repo, issue_number: prNumber, per_page: 100 }
    );

    const outdatedPrefix =
      '> \u26a0\ufe0f **Outdated** \u2014 this review was for an earlier revision. See the latest review below.\n\n';

    for (const comment of comments) {
      if (
        comment.body &&
        comment.body.includes(AI_REVIEW_SIGNATURE) &&
        !comment.body.startsWith('>')
      ) {
        await octokit.request(
          'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}',
          {
            owner,
            repo,
            comment_id: comment.id,
            body: outdatedPrefix + comment.body
          }
        );
      }
    }
  } catch (error) {
    // Non-fatal — log but don't fail the review
    getLogger().warn(`Failed to supersede previous reviews on PR #${prNumber}: ${error.message}`);
  }
}

async function reviewPullRequest(octokit, owner, repo, prNumber) {
  const config = getConfig();
  const aiConfig = config.ai_review;

  if (!aiConfig?.enabled) {
    return { success: false, error: 'AI review is not enabled in configuration.' };
  }

  // Rate limiting: reject if <5min since last review on same PR
  const rateKey = `${owner}/${repo}#${prNumber}`;
  if (isRateLimited(rateKey)) {
    return {
      success: false,
      error: 'Rate limited: please wait at least 5 minutes between reviews on the same PR.'
    };
  }

  // Endpoint validation
  if (!aiConfig.allow_remote_endpoint && !isLocalEndpoint(aiConfig.endpoint)) {
    return {
      success: false,
      error: 'Remote AI endpoints are not allowed. Set allow_remote_endpoint: true to enable.'
    };
  }

  try {
    const prData = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber
    });

    const diffResponse = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: 'diff' }
    });

    const filesResponse = await octokit.request(
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
      { owner, repo, pull_number: prNumber }
    );

    // Mechanical oracle: only runs for repos that ship rivet.yaml AND have
    // the binary configured. Failures are non-fatal — the model path still
    // runs.
    let oracleFindings = [];
    let oracleSummary = null;
    const rivetCfg = config.rivet_oracle;
    if (rivetCfg?.enabled && rivetCfg?.binary_path) {
      const headSha = prData.data.head?.sha;
      const baseSha = prData.data.base?.sha;
      try {
        if (headSha && (await hasRivetYaml(octokit, owner, repo, headSha))) {
          oracleSummary = await withTempRepoCheckout(
            octokit,
            owner,
            repo,
            headSha,
            (repoPath) => runRivetOracle(rivetCfg.binary_path, repoPath, {
              baseRef: baseSha,
              timeout: rivetCfg.timeout_ms || 60000
            })
          );
          if (oracleSummary?.findings) {
            oracleFindings = oracleSummary.findings;
          }
          getLogger().info(
            { pr: prNumber, oracleFindings: oracleFindings.length },
            'Rivet oracle complete'
          );
        }
      } catch (err) {
        getLogger().warn(
          { pr: prNumber, err: err.message },
          'Rivet oracle failed — continuing with model-only review'
        );
      }
    }

    // Strict-JSON contract by default; legacy freeform if user explicitly
    // overrides system_prompt in config.
    const systemPrompt = aiConfig.system_prompt || STRICT_SYSTEM_PROMPT;
    const useStrictMode = !aiConfig.system_prompt;

    const diffText = typeof diffResponse.data === 'string' ? diffResponse.data : '';
    const userPrompt = buildReviewPrompt(
      prData.data,
      diffText,
      filesResponse.data,
      aiConfig.max_diff_size || 12000
    );

    const aiResponse = await callLocalAI(
      aiConfig.endpoint,
      aiConfig.model || 'local-model',
      systemPrompt,
      userPrompt,
      {
        maxTokens: aiConfig.max_tokens || 2000,
        temperature: aiConfig.temperature || 0.3,
        timeout: aiConfig.timeout || 120000
      }
    );

    recordReview(rateKey);

    const headSha = prData.data.head?.sha || '';
    const meta = {
      baseRepo: prData.data.base?.repo?.full_name || `${owner}/${repo}`,
      baseBranch: prData.data.base?.ref || '',
      headRepo: prData.data.head?.repo?.full_name || `${owner}/${repo}`,
      headBranch: prData.data.head?.ref || '',
    };

    let comment;
    let assessment = 'unknown';
    let findingsCount = 0;

    if (useStrictMode) {
      const parsed = tryParseReview(aiResponse);
      let modelFindings = [];
      let modelSummary = null;

      if (parsed.ok) {
        modelFindings = filterFindings(parsed.data.findings, diffText);
        modelSummary = parsed.data.summary;
        const droppedCount = parsed.data.findings.length - modelFindings.length;
        if (droppedCount > 0) {
          getLogger().info(
            { pr: prNumber, droppedCount, kept: modelFindings.length },
            'Filtered out hedging/unquoted findings from model output'
          );
        }
      } else {
        getLogger().warn(
          { pr: prNumber, error: parsed.error, sample: aiResponse.slice(0, 200) },
          'AI review JSON parse failed'
        );
      }

      // Oracle findings come first — they're mechanically validated, not
      // subject to the slop filter, and most readable when grouped.
      const allFindings = [...oracleFindings, ...modelFindings];

      // If model failed AND oracle had nothing → skip post entirely.
      if (!parsed.ok && oracleFindings.length === 0) {
        getLogger().info(
          { pr: prNumber },
          'AI review skipped: model parse failed and no oracle findings'
        );
        return { success: false, error: `parse: ${parsed.error}`, skipped: true };
      }

      // Compose summary: prefer the model's, fall back to oracle-derived.
      const summary = modelSummary ||
        (oracleFindings.length > 0
          ? `${oracleFindings.length} mechanical finding(s) from rivet oracle.`
          : 'No findings.');

      const renderInput = { summary, findings: allFindings };
      comment = renderReviewMarkdown(renderInput, prNumber, headSha, meta);
      assessment = computeVerdict(allFindings);
      findingsCount = allFindings.length;

      if (comment === null) {
        getLogger().info(
          { pr: prNumber },
          'AI review approved with no findings — skipping post'
        );
        storeReview({
          repo: `${owner}/${repo}`,
          prNumber,
          headSha: headSha.substring(0, 7),
          timestamp: new Date().toISOString(),
          status: 'open',
          assessment,
          findings: 0
        });
        return { success: true, skipped: true, assessment };
      }
    } else {
      // Legacy freeform path — preserved for users who set system_prompt
      // explicitly. No structural validation; old footer/format applied.
      comment = formatReviewComment(aiResponse, prNumber, headSha, meta);
    }

    // Mark previous bot reviews as outdated
    await supersedePreviousReviews(octokit, owner, repo, prNumber);

    await octokit.request(
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { owner, repo, issue_number: prNumber, body: comment }
    );

    storeReview({
      repo: `${owner}/${repo}`,
      prNumber,
      headSha: headSha.substring(0, 7),
      timestamp: new Date().toISOString(),
      status: 'open',
      assessment,
      findings: findingsCount
    });

    return { success: true, comment, assessment, findings: findingsCount };
  } catch (error) {
    getLogger().error(`❌ Error reviewing PR #${prNumber}:`, error.message);
    return { success: false, error: error.message };
  }
}

// ---------------------------------------------------------------------------
// Review storage — simple in-memory store with file persistence
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');

let _reviews = [];

function loadReviews() {
  try {
    if (fs.existsSync(REVIEWS_PATH)) {
      _reviews = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
    }
  } catch {
    _reviews = [];
  }
  return _reviews;
}

function saveReviews() {
  try {
    const dir = path.dirname(REVIEWS_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(REVIEWS_PATH, JSON.stringify(_reviews, null, 2));
  } catch (error) {
    getLogger().warn(`Failed to persist reviews: ${error.message}`);
  }
}

function storeReview(entry) {
  _reviews.push(entry);
  saveReviews();
}

function getReviews(opts = {}) {
  const { limit, offset = 0 } = typeof opts === 'object' ? opts : {};
  // Newest-first
  const sorted = [..._reviews].reverse();
  if (limit !== undefined && limit !== null) return sorted.slice(offset, offset + limit);
  return sorted;
}

function getReviewStats() {
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  let total = 0, approve = 0, minor = 0, major = 0, unknown = 0, thisWeek = 0, totalFindings = 0;
  for (const r of _reviews) {
    total++;
    if (r.assessment === 'approve') approve++;
    else if (r.assessment === 'minor') minor++;
    else if (r.assessment === 'major') major++;
    else unknown++;
    if (r.timestamp && new Date(r.timestamp).getTime() > weekAgo) thisWeek++;
    totalFindings += r.findings || 0;
  }
  return { total, approve, minor, major, unknown, thisWeek, avgFindings: total ? +(totalFindings / total).toFixed(1) : 0 };
}

/**
 * Update the status of all reviews matching a repo + PR number.
 * @param {string} repo  "owner/repo"
 * @param {number} prNumber
 * @param {'open'|'merged'|'closed'} status
 */
function updateReviewStatus(repo, prNumber, status) {
  let updated = 0;
  for (const review of _reviews) {
    if (review.repo === repo && review.prNumber === prNumber) {
      review.status = status;
      updated++;
    }
  }
  if (updated > 0) saveReviews();
  return updated;
}

/** Reset reviews in-memory (for testing). */
function _resetReviews() {
  _reviews = [];
}

// Load persisted reviews on module init
loadReviews();

export {
  reviewPullRequest,
  buildReviewPrompt,
  callLocalAI,
  formatReviewComment,
  isLocalEndpoint,
  sanitizeAIOutput,
  parseDiffByFile,
  classifyFile,
  prioritizeFiles,
  supersedePreviousReviews,
  storeReview,
  getReviews,
  getReviewStats,
  updateReviewStatus,
  _reviewTimestamps,
  _resetReviews,
  AI_REVIEW_SIGNATURE
};
