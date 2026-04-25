/**
 * Issue-driven repository provisioning.
 *
 * Pattern: a separate "controller" repo (e.g. pulseengine/repo-requests) holds
 * an issue form; a maintainer files an issue, an authorized approver reacts,
 * and Temper provisions the new repo with full configuration.
 *
 * Cut A architectural decision: Temper is the brain. The controller repo only
 * holds the issue-form schema. All validation, creation, and configuration
 * happens here.
 */

import { getLogger } from './logger.js';
import { getConfig } from './config.js';
import { configureRepository } from './repository.js';

/**
 * Parse a GitHub issue-form body into a flat object.
 *
 * GitHub renders an issue-form submission as alternating headings and content:
 *
 *   ### Repository name
 *
 *   my-new-repo
 *
 *   ### Visibility
 *
 *   private
 *
 * This function walks the body and yields { 'repository name': 'my-new-repo',
 * 'visibility': 'private', ... }. Keys are lowercased and trimmed; values
 * preserve internal whitespace but trim leading/trailing.
 *
 * "_No response_" (GitHub's rendering for an unanswered optional field) is
 * normalised to undefined.
 *
 * @param {string} body
 * @returns {Record<string, string>}
 */
export function parseIssueFormBody(body) {
  if (typeof body !== 'string') return {};

  const result = {};
  const lines = body.split(/\r?\n/);
  let currentKey = null;
  let buffer = [];

  function flush() {
    if (currentKey === null) return;
    const value = buffer.join('\n').trim();
    if (value && value !== '_No response_') {
      result[currentKey] = value;
    }
    buffer = [];
  }

  for (const line of lines) {
    const headerMatch = line.match(/^###\s+(.+?)\s*$/);
    if (headerMatch) {
      flush();
      currentKey = headerMatch[1].trim().toLowerCase();
    } else if (currentKey !== null) {
      buffer.push(line);
    }
  }
  flush();

  return result;
}

const VALID_VISIBILITIES = new Set(['public', 'private', 'internal']);
const REPO_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Validate the parsed issue-form fields. Returns either {valid: true, params}
 * with normalised provisioning params, or {valid: false, error} with a human
 * message that will be posted back on the issue.
 */
export function validateProvisionRequest(fields) {
  const name = fields['repository name'] || fields.name;
  if (!name) return { valid: false, error: 'Missing field "Repository name".' };
  if (!REPO_NAME_RE.test(name)) {
    return {
      valid: false,
      error: `Invalid repository name "${name}". Use only letters, numbers, dots, hyphens, underscores.`
    };
  }

  const visibilityRaw = (fields.visibility || 'private').toLowerCase();
  if (!VALID_VISIBILITIES.has(visibilityRaw)) {
    return {
      valid: false,
      error: `Invalid visibility "${visibilityRaw}". Allowed: public, private, internal.`
    };
  }

  const description = fields.description;
  const templateRepo = fields['template repository'] || fields.template;
  const topicsRaw = fields.topics || '';
  const topics = topicsRaw
    .split(/[,\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  return {
    valid: true,
    params: {
      name,
      visibility: visibilityRaw,
      description,
      templateRepo,
      topics
    }
  };
}

/**
 * Create the repo on GitHub. Uses template generation when a template repo is
 * supplied (POST /repos/{template_owner}/{template_repo}/generate); otherwise
 * a plain create (POST /orgs/{org}/repos). Returns the created repo payload.
 */
async function createGitHubRepo(octokit, org, params) {
  if (params.templateRepo) {
    const [tplOwner, tplRepo] = params.templateRepo.split('/');
    if (!tplOwner || !tplRepo) {
      throw new Error(`Template "${params.templateRepo}" must be "owner/repo".`);
    }
    const response = await octokit.request(
      'POST /repos/{template_owner}/{template_repo}/generate',
      {
        template_owner: tplOwner,
        template_repo: tplRepo,
        owner: org,
        name: params.name,
        description: params.description,
        private: params.visibility !== 'public',
        include_all_branches: false
      }
    );
    return response.data;
  }

  const response = await octokit.request('POST /orgs/{org}/repos', {
    org,
    name: params.name,
    description: params.description,
    visibility: params.visibility,
    auto_init: true,
    has_issues: true,
    has_projects: false,
    has_wiki: false
  });
  return response.data;
}

/**
 * Provision a repo from an approved issue-form request.
 * Called by the scheduler when a `provision-repo` task is claimed.
 *
 * @param {object} payload {sourceOwner, sourceRepo, sourceIssue, params}
 * @param {object} ctx     {octokit, logger}
 */
export async function provisionRepo(payload, { octokit, logger = getLogger() }) {
  const { sourceOwner, sourceRepo, sourceIssue, params } = payload;
  const config = getConfig();
  const targetOrg = config?.organization || sourceOwner;

  logger.info({ params, targetOrg }, 'Provisioning new repo from issue request');

  let created;
  try {
    created = await createGitHubRepo(octokit, targetOrg, params);
  } catch (err) {
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner: sourceOwner,
      repo: sourceRepo,
      issue_number: sourceIssue,
      body: `❌ Failed to create repository: ${err.message}`
    });
    throw err;
  }

  if (params.topics?.length) {
    try {
      await octokit.request('PUT /repos/{owner}/{repo}/topics', {
        owner: targetOrg,
        repo: params.name,
        names: params.topics
      });
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to set topics on new repo');
    }
  }

  // Tag the new repo with a custom property linking back to the source issue,
  // creating a durable audit trail. Failure is non-fatal — custom properties
  // require the property to be defined at the org level first.
  try {
    await octokit.request(
      'PATCH /orgs/{org}/properties/values',
      {
        org: targetOrg,
        repository_names: [params.name],
        properties: [
          {
            property_name: 'provisioned-from',
            value: `${sourceOwner}/${sourceRepo}#${sourceIssue}`
          }
        ]
      }
    );
  } catch (err) {
    logger.info({ err: err.message }, 'Could not set provisioned-from custom property (likely undefined)');
  }

  // Apply standard configuration. The default branch may or may not exist
  // depending on whether the repo was template-generated or auto_init was used;
  // configureRepository handles both cases.
  const skipBranchScopedWork = !created.default_branch;
  await configureRepository(octokit, created, undefined, { skipBranchScopedWork });

  await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
    owner: sourceOwner,
    repo: sourceRepo,
    issue_number: sourceIssue,
    body:
      `✅ Repository created: ${created.html_url}\n\n` +
      `Configuration applied. ` +
      (skipBranchScopedWork
        ? 'Branch-scoped configuration (templates, codeowners, dependabot) will be applied after the first push.'
        : 'All standard files committed to default branch.')
  });

  // Close the source issue.
  await octokit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', {
    owner: sourceOwner,
    repo: sourceRepo,
    issue_number: sourceIssue,
    state: 'closed',
    state_reason: 'completed'
  });

  return { repoUrl: created.html_url, name: created.name };
}
