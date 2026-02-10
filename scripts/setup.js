#!/usr/bin/env node

/**
 * Bootstrap script for probot-repo-configurator.
 *
 * Replaces placeholder values across all config/doc files with your
 * org-specific settings. Run once after cloning or forking the template.
 *
 * Interactive:   node scripts/setup.js
 * Non-interactive: node scripts/setup.js --org myorg --user myuser --email me@example.com
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--org' && value) { args.org = value; i++; }
    else if (flag === '--user' && value) { args.user = value; i++; }
    else if (flag === '--email' && value) { args.email = value; i++; }
    else if (flag === '--repo' && value) { args.repo = value; i++; }
    else if (flag === '--help' || flag === '-h') { args.help = true; }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Interactive prompts (readline-based, zero deps)
// ---------------------------------------------------------------------------

function prompt(rl, question, defaultValue) {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function collectInteractive(defaults) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log('\nProbot Repository Configurator - Setup\n');

  const org = await prompt(rl, 'GitHub organization', defaults.org);
  const user = await prompt(rl, 'GitHub username (admin/reviewer)', defaults.user);
  const email = await prompt(rl, 'Contact email (Code of Conduct)', defaults.email);
  const repo = await prompt(rl, 'Repository name', defaults.repo);

  rl.close();
  return { org, user, email, repo };
}

// ---------------------------------------------------------------------------
// File replacement logic
// ---------------------------------------------------------------------------

/**
 * Replace all occurrences of `from` with `to` in the given file.
 * Returns true if any replacements were made.
 */
function replaceInFile(filePath, replacements) {
  const abs = path.resolve(ROOT, filePath);
  if (!fs.existsSync(abs)) return false;

  let content = fs.readFileSync(abs, 'utf8');
  const original = content;

  for (const [from, to] of replacements) {
    content = content.split(from).join(to);
  }

  if (content !== original) {
    fs.writeFileSync(abs, content, 'utf8');
    return true;
  }
  return false;
}

function applyReplacements({ org, user, email, repo }) {
  const repoFullName = `${org}/${repo}`;
  const changed = [];

  // config.yml + config.yml.example
  for (const f of ['config.yml', 'config.yml.example']) {
    if (replaceInFile(f, [
      ['your-org', org],
      ['your-github-username', user],
    ])) changed.push(f);
  }

  // .github/CODEOWNERS
  if (replaceInFile('.github/CODEOWNERS', [
    ['@your-github-username', `@${user}`],
  ])) changed.push('.github/CODEOWNERS');

  // CODE_OF_CONDUCT.md
  if (replaceInFile('CODE_OF_CONDUCT.md', [
    ['ralf_beier@me.com', email],
  ])) changed.push('CODE_OF_CONDUCT.md');

  // GITHUB_APP_SETUP.md
  if (replaceInFile('GITHUB_APP_SETUP.md', [
    ['YOUR_ORG', org],
    ['your-org', org],
  ])) changed.push('GITHUB_APP_SETUP.md');

  // CONTRIBUTING.md
  if (replaceInFile('CONTRIBUTING.md', [
    ['your-org', org],
  ])) changed.push('CONTRIBUTING.md');

  // README.md
  if (replaceInFile('README.md', [
    [`YOUR-ORG/probot-repo-configurator`, `${repoFullName}`],
    [`YOUR-ORG/${repo}`, `${repoFullName}`],
    // Uncomment the CI badge if it was commented out
    ['<!-- [![CI]', '[![CI]'],
    ['badge.svg)](', 'badge.svg)]('],
    [') -->', ')'],
  ])) changed.push('README.md');

  // package.json — update repo URLs and author
  if (replaceInFile('package.json', [
    ['avrabe/probot-repo-configurator', repoFullName],
    ['"author": "pulseengine"', `"author": "${org}"`],
    ['"author": ""', `"author": "${org}"`],
  ])) changed.push('package.json');

  // .env.example
  if (replaceInFile('.env.example', [
    ['ORGANIZATION=', `ORGANIZATION=${org}`],
  ])) changed.push('.env.example');

  return changed;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    console.log(`
Usage: node scripts/setup.js [options]

Options:
  --org <name>     GitHub organization name
  --user <name>    GitHub username (for CODEOWNERS, reviewers, admin)
  --email <addr>   Contact email (for Code of Conduct)
  --repo <name>    Repository name (default: probot-repo-configurator)
  -h, --help       Show this help

Examples:
  node scripts/setup.js
  node scripts/setup.js --org myorg --user myuser --email me@example.com
  npm run setup -- --org myorg --user myuser --email me@example.com
`);
    process.exit(0);
  }

  const defaults = {
    org: args.org || '',
    user: args.user || '',
    email: args.email || '',
    repo: args.repo || 'probot-repo-configurator',
  };

  // If all required args provided, skip interactive mode
  let values;
  if (args.org && args.user && args.email) {
    values = { ...defaults };
    console.log(`\nSetup: org=${values.org} user=${values.user} email=${values.email} repo=${values.repo}`);
  } else {
    values = await collectInteractive(defaults);
  }

  // Validate
  if (!values.org || !values.user || !values.email) {
    console.error('\nError: org, user, and email are all required.');
    process.exit(1);
  }

  if (!values.repo) {
    values.repo = 'probot-repo-configurator';
  }

  const changed = applyReplacements(values);

  if (changed.length === 0) {
    console.log('\nNo changes needed — placeholders may already be replaced.');
  } else {
    console.log(`\nUpdated ${changed.length} files:`);
    for (const f of changed) {
      console.log(`  - ${f}`);
    }
  }

  console.log('\nSetup complete. Next steps:');
  console.log('  1. cp .env.example .env');
  console.log('  2. Fill in APP_ID, PRIVATE_KEY, WEBHOOK_SECRET in .env');
  console.log('  3. npm install && npm start');
  console.log('');
}

main().catch((err) => {
  console.error('Setup failed:', err);
  process.exit(1);
});
