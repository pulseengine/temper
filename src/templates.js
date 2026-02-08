import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertRepoFile } from './github-api.js';
import { getLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function applyTemplates(octokit, owner, repo, templatesConfig) {
  try {
    getLogger().info(`Applying templates to ${owner}/${repo}`);

    if (templatesConfig.pull_request) {
      const prTemplatePath = path.resolve(__dirname, '..', templatesConfig.pull_request);
      if (!fs.existsSync(prTemplatePath)) {
        getLogger().warn(`Pull request template not found at ${prTemplatePath}, skipping`);
      } else {
        const prTemplateContent = fs.readFileSync(prTemplatePath, 'utf8');
        await upsertRepoFile(
          octokit,
          owner,
          repo,
          '.github/PULL_REQUEST_TEMPLATE.md',
          prTemplateContent,
          'Add/Update pull request template'
        );
      }
    }

    if (templatesConfig.issue) {
      const issueTemplateDir = path.resolve(__dirname, '..', templatesConfig.issue);
      if (!fs.existsSync(issueTemplateDir) || !fs.statSync(issueTemplateDir).isDirectory()) {
        getLogger().warn(`Issue template directory not found at ${issueTemplateDir}, skipping`);
      } else {
        const files = fs.readdirSync(issueTemplateDir);
        for (const file of files) {
          if (!file.endsWith('.md') && !file.endsWith('.yml') && !file.endsWith('.yaml')) {
            continue;
          }
          const templatePath = path.join(issueTemplateDir, file);
          const templateContent = fs.readFileSync(templatePath, 'utf8');
          await upsertRepoFile(
            octokit,
            owner,
            repo,
            `.github/ISSUE_TEMPLATE/${file}`,
            templateContent,
            `Add/Update issue template: ${file}`
          );
        }
      }
    }

    getLogger().info(`Templates applied to ${owner}/${repo}`);
  } catch (error) {
    getLogger().error(`Error applying templates to ${owner}/${repo}: ${error.message}`);
    throw error;
  }
}

async function applyCodeowners(octokit, owner, repo, codeownersPath) {
  try {
    const resolvedPath = path.resolve(__dirname, '..', codeownersPath);
    if (!fs.existsSync(resolvedPath)) {
      getLogger().warn(`CODEOWNERS not found at ${resolvedPath}, skipping`);
      return;
    }

    const codeownersContent = fs.readFileSync(resolvedPath, 'utf8');
    await upsertRepoFile(
      octokit,
      owner,
      repo,
      '.github/CODEOWNERS',
      codeownersContent,
      'Add/Update CODEOWNERS'
    );
    getLogger().info(`CODEOWNERS applied to ${owner}/${repo}`);
  } catch (error) {
    getLogger().error(`Error applying CODEOWNERS to ${owner}/${repo}: ${error.message}`);
    throw error;
  }
}

export {
  applyTemplates,
  applyCodeowners
};
