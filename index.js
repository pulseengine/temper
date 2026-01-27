const { Probot } = require('probot');
const { Octokit } = require('@octokit/rest');
const fs = require('fs');
const yaml = require('js-yaml');

// Initialize the Probot app
const probot = new Probot({
  // GitHub App credentials will be loaded from environment variables
});

// Load configuration from YAML file
let TARGET_SETTINGS = {};
try {
  const config = yaml.load(fs.readFileSync('config.yml', 'utf8'));
  TARGET_SETTINGS = config.settings.merge;
  console.log('Configuration loaded from config.yml');
} catch (error) {
  console.error('Error loading config.yml, using default settings:', error.message);
  TARGET_SETTINGS = {
    allow_merge_commit: false,
    allow_squash_merge: false,
    allow_rebase_merge: true,
    delete_branch_on_merge: true
  };
}

// Function to configure a repository
async function configureRepository(octokit, owner, repo) {
  try {
    console.log(`Configuring repository: ${owner}/${repo}`);
    
    // Apply the target settings
    await octokit.request('PATCH /repos/{owner}/{repo}', {
      owner,
      repo,
      ...TARGET_SETTINGS
    });
    
    // Apply branch protection if configured
    if (config && config.branch_protection) {
      await applyBranchProtection(octokit, owner, repo, config.branch_protection);
    }
    
    // Apply templates if configured
    if (config && config.templates) {
      await applyTemplates(octokit, owner, repo, config.templates);
    }
    
    // Check existing Dependabot configuration first
    if (config && config.dependabot) {
      const dependabotCheck = await checkExistingDependabotConfig(octokit, owner, repo);
      
      // Fix any label issues first
      if (dependabotCheck.labelIssues.length > 0) {
        await fixDependabotPRLabels(octokit, owner, repo, dependabotCheck.labelIssues);
      }
      
      // Only apply config if it doesn't exist or doesn't match
      if (!dependabotCheck.exists || !dependabotCheck.matchesTarget) {
        await applyDependabotConfig(octokit, owner, repo, config.dependabot);
      }
    }
    
    // Apply pull request rules
    if (config && config.pull_request_rules) {
      await applyPullRequestRules(octokit, owner, repo, config.pull_request_rules);
    }
    
    console.log(`✅ Successfully configured ${owner}/${repo}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error configuring ${owner}/${repo}:`, error.message);
    return { success: false, error: error.message };
  }
}

async function applyBranchProtection(octokit, owner, repo, protectionConfig) {
  try {
    console.log(`Applying branch protection to ${owner}/${repo}`);
    
    await octokit.request('PUT /repos/{owner}/{repo}/branches/{branch}/protection', {
      owner,
      repo,
      branch: 'main',
      required_status_checks: protectionConfig.required_status_checks ? {
        strict: protectionConfig.required_status_checks.strict || false,
        contexts: protectionConfig.required_status_checks.contexts || []
      } : null,
      enforce_admins: protectionConfig.enforce_admins || null,
      required_pull_request_reviews: protectionConfig.required_pull_request_reviews || null,
      restrictions: protectionConfig.restrictions || null
    });
    
    console.log(`✅ Branch protection applied to ${owner}/${repo}`);
  } catch (error) {
    console.error(`❌ Error applying branch protection to ${owner}/${repo}:`, error.message);
    throw error;
  }
}

async function applyTemplates(octokit, owner, repo, templatesConfig) {
  try {
    console.log(`Applying templates to ${owner}/${repo}`);
    
    // Create .github directory if it doesn't exist
    try {
      await octokit.request('PUT /repos/{owner}/{repo}/contents/.github', {
        owner,
        repo,
        path: '.github',
        message: 'Create .github directory'
      });
    } catch (error) {
      // Directory already exists, continue
      if (error.status !== 409) {
        throw error;
      }
    }
    
    // Apply pull request template if configured
    if (templatesConfig.pull_request) {
      const prTemplateContent = fs.readFileSync(templatesConfig.pull_request, 'utf8');
      await octokit.request('PUT /repos/{owner}/{repo}/contents/.github/PULL_REQUEST_TEMPLATE.md', {
        owner,
        repo,
        path: '.github/PULL_REQUEST_TEMPLATE.md',
        message: 'Add pull request template',
        content: Buffer.from(prTemplateContent).toString('base64')
      });
    }
    
    console.log(`✅ Templates applied to ${owner}/${repo}`);
  } catch (error) {
    console.error(`❌ Error applying templates to ${owner}/${repo}:`, error.message);
    throw error;
  }
}

// Listen for new repository creation events
probot.on('repository.created', async (context) => {
  const { repository, organization } = context.payload;
  
   // Only process repositories in the configured organization
   const TARGET_ORG = config && config.organization ? config.organization : 'pulseengine';
   if (organization && organization.login === TARGET_ORG) {
    console.log(`New repository created: ${repository.full_name}`);
    
    // Configure the repository
    const result = await configureRepository(
      context.octokit,
      repository.owner.login,
      repository.name
    );
    
    // Create an issue to document the configuration
    if (repository.has_issues) {
      await context.octokit.issues.create({
        owner: repository.owner.login,
        repo: repository.name,
        title: 'Repository Configuration',
        body: result.success
          ? '✅ This repository has been automatically configured with standard merge settings:\n\n' +
            '- Rebase merges only\n' +
            '- Branch deletion after merge\n' +
            '- Merge commits disabled\n' +
            '- Squash merges disabled'
          : `❌ Configuration failed: ${result.error}`,
        labels: ['automation', 'configuration']
      });
    }
  }
});

// Listen for configuration commands in issue comments
probot.on('issue_comment.created', async (context) => {
  const { comment, repository } = context.payload;
  
  // Check for various commands
  if (comment.body.trim() === '/configure-repo') {
    // Allow organization members to trigger configuration
    const isOrgMember = await checkOrganizationMembership(context.octokit, context.payload.repository.owner.login, context.payload.sender.login);
    
    if (isOrgMember) {
    
    console.log(`Manual configuration requested for: ${repository.full_name}`);
    
    // Configure the repository
    const result = await configureRepository(
      context.octokit,
      repository.owner.login,
      repository.name
    );
    
    // Respond to the comment
    await context.octokit.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: context.payload.issue.number,
      body: result.success
        ? '✅ Repository configured with standard merge settings!'
        : `❌ Configuration failed: ${result.error}`
    });
  } else {
    await context.octokit.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: context.payload.issue.number,
      body: '❌ You must be an organization member to use this command.'
    });
  }
} else if (comment.body.trim() === '/sync-all-repos') {
  // Allow organization members to trigger full synchronization
  const isOrgMember = await checkOrganizationMembership(context.octokit, context.payload.repository.owner.login, context.payload.sender.login);
  
  if (isOrgMember) {
    const syncResult = await synchronizeAllRepositories(context.octokit, context.payload.organization.login);
    
    await context.octokit.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: context.payload.issue.number,
      body: syncResult.success
        ? `✅ Synchronized all repositories! Processed ${syncResult.repositoriesProcessed} repositories.`
        : `❌ Synchronization failed: ${syncResult.error}`
    });
  } else {
    await context.octokit.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: context.payload.issue.number,
      body: '❌ You must be an organization member to use this command.'
    });
  }
} else if (comment.body.trim() === '/check-config') {
  // Allow organization members to check current configuration
  const isOrgMember = await checkOrganizationMembership(context.octokit, context.payload.repository.owner.login, context.payload.sender.login);
  
  if (isOrgMember) {
    const configReport = await generateConfigurationReport(context.octokit, repository.owner.login, repository.name);
    
    await context.octokit.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: context.payload.issue.number,
      body: configReport
    });
  } else {
    await context.octokit.issues.createComment({
      owner: repository.owner.login,
      repo: repository.name,
      issue_number: context.payload.issue.number,
      body: '❌ You must be an organization member to use this command.'
    });
  }
  } else if (comment.body.trim() === '/check-dependabot') {
    // Allow organization members to check Dependabot configuration
    const isOrgMember = await checkOrganizationMembership(context.octokit, context.payload.repository.owner.login, context.payload.sender.login);
    
    if (isOrgMember) {
      const dependabotReport = await checkDependabotConfiguration(context.octokit, repository.owner.login, repository.name);
      
      await context.octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: context.payload.issue.number,
        body: dependabotReport
      });
    } else {
      await context.octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: context.payload.issue.number,
        body: '❌ You must be an organization member to use this command.'
      });
    }
  } else if (comment.body.trim() === '/fix-dependabot-labels') {
    // Allow organization members to fix Dependabot labels
    const isOrgMember = await checkOrganizationMembership(context.octokit, context.payload.repository.owner.login, context.payload.sender.login);
    
    if (isOrgMember) {
      const dependabotCheck = await checkExistingDependabotConfig(context.octokit, repository.owner.login, repository.name);
      
      if (dependabotCheck.labelIssues.length > 0) {
        const fixResult = await fixDependabotPRLabels(context.octokit, repository.owner.login, repository.name, dependabotCheck.labelIssues);
        
        await context.octokit.issues.createComment({
          owner: repository.owner.login,
          repo: repository.name,
          issue_number: context.payload.issue.number,
          body: `✅ Fixed labels on ${fixResult.fixedIssues} Dependabot PRs!`
        });
      } else {
        await context.octokit.issues.createComment({
          owner: repository.owner.login,
          repo: repository.name,
          issue_number: context.payload.issue.number,
          body: '✅ No Dependabot PR label issues found.'
        });
      }
    } else {
      await context.octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: context.payload.issue.number,
        body: '❌ You must be an organization member to use this command.'
      });
    }
  } else if (comment.body.trim() === '/analyze-org') {
    // Allow organization members to analyze all repositories
    const isOrgMember = await checkOrganizationMembership(octokit, context.payload.repository.owner.login, context.payload.sender.login);
    
    if (isOrgMember) {
      const org = context.payload.organization.login;
      const analysisReport = await generateOrganizationAnalysisReport(context.octokit, org);
      
      // Create a new issue for the report since it might be very long
      const reportIssue = await context.octokit.issues.create({
        owner: repository.owner.login,
        repo: repository.name,
        title: `Organization Analysis Report - ${new Date().toISOString().split('T')[0]}`,
        body: analysisReport,
        labels: ['analysis', 'report', 'automation']
      });
      
      await context.octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: context.payload.issue.number,
        body: `✅ Generated organization analysis report in issue #${reportIssue.data.number}`
      });
    } else {
      await context.octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: context.payload.issue.number,
        body: '❌ You must be an organization member to use this command.'
      });
    }
  } else if (comment.body.trim() === '/check-merge-strategy') {
    // Allow organization members to check PR merge strategy
    const isOrgMember = await checkOrganizationMembership(octokit, context.payload.repository.owner.login, context.payload.sender.login);
    
    if (isOrgMember) {
      // Extract PR number from the issue
      const issueNumber = context.payload.issue.number;
      
      const strategyCheck = await checkPRMergeStrategy(
        context.octokit,
        repository.owner.login,
        repository.name,
        issueNumber
      );
      
      if (strategyCheck.error) {
        await context.octokit.issues.createComment({
          owner: repository.owner.login,
          repo: repository.name,
          issue_number: issueNumber,
          body: `❌ Error checking merge strategy: ${strategyCheck.error}`
        });
      } else {
        let response = `## Merge Strategy Analysis for PR #${issueNumber}\n\n`;
        response += `**PR Title:** ${strategyCheck.prTitle}\n\n`;
        response += `**Base Branch:** ${strategyCheck.baseBranch}\n\n`;
        response += `**Commits:** ${strategyCheck.commitCount} total, ${strategyCheck.signedCommitCount} signed\n\n`;
        
        response += `### Current Branch Protection\n`;
        response += `- Allow Merge Commit: ${strategyCheck.currentMergeStrategy.allowMergeCommit ? '✅' : '❌'}\n`;
        response += `- Allow Squash Merge: ${strategyCheck.currentMergeStrategy.allowSquashMerge ? '✅' : '❌'}\n`;
        response += `- Allow Rebase Merge: ${strategyCheck.currentMergeStrategy.allowRebaseMerge ? '✅' : '❌'}\n\n`;
        
        if (strategyCheck.hasSignedCommits) {
          response += `⚠️  This PR contains signed commits!\n\n`;
          response += `💡 **Recommendation:** Use merge commit to preserve signatures.\n`;
          response += `Use command: /allow-merge-commit`;
        } else {
          response += `✅ No signed commits detected.\n\n`;
          response += `💡 **Recommendation:** Current merge strategy is appropriate.`;
        }
        
        await context.octokit.issues.createComment({
          owner: repository.owner.login,
          repo: repository.name,
          issue_number: issueNumber,
          body: response
        });
      }
    } else {
      await context.octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: context.payload.issue.number,
        body: '❌ You must be an organization member to use this command.'
      });
    }
  } else if (comment.body.trim() === '/allow-merge-commit') {
    // Allow organization members to temporarily allow merge commits
    const isOrgMember = await checkOrganizationMembership(octokit, context.payload.repository.owner.login, context.payload.sender.login);
    
    if (isOrgMember) {
      const issueNumber = context.payload.issue.number;
      
      const result = await handleSignedCommitMerge(
        context.octokit,
        repository.owner.login,
        repository.name,
        issueNumber
      );
      
      if (result.success) {
        if (result.action === 'temporarily_allowed_merge_commits') {
          await context.octokit.issues.createComment({
            owner: repository.owner.login,
            repo: repository.name,
            issue_number: issueNumber,
            body: `✅ ${result.message}\n\n` +
                  `You can now merge this PR using the merge commit strategy to preserve signed commits.\n\n` +
                  `⚠️  Remember: Branch protection will automatically restore to rebase-only after 1 hour.`
          });
        } else {
          await context.octokit.issues.createComment({
            owner: repository.owner.login,
            repo: repository.name,
            issue_number: issueNumber,
            body: `ℹ️  ${result.message}`
          });
        }
      } else {
        await context.octokit.issues.createComment({
          owner: repository.owner.login,
          repo: repository.name,
          issue_number: issueNumber,
          body: `❌ Error: ${result.error}`
        });
      }
    } else {
      await context.octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: context.payload.issue.number,
        body: '❌ You must be an organization member to use this command.'
      });
    }
  }
});
      
      await context.octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: context.payload.issue.number,
        body: `✅ Generated organization analysis report in issue #${reportIssue.data.number}`
      });
    } else {
      await context.octokit.issues.createComment({
        owner: repository.owner.login,
        repo: repository.name,
        issue_number: context.payload.issue.number,
        body: '❌ You must be an organization member to use this command.'
      });
    }
  }
});

// Function to check organization membership
async function checkOrganizationMembership(octokit, org, username) {
  try {
    const response = await octokit.request('GET /orgs/{org}/members/{username}', {
      org,
      username
    });
    return response.status === 204; // 204 means member exists
  } catch (error) {
    if (error.status === 404) {
      return false; // User is not a member
    }
    console.error('Error checking organization membership:', error.message);
    return false;
  }
}

// Function to synchronize all repositories in organization
async function synchronizeAllRepositories(octokit, org) {
  try {
    console.log(`Starting synchronization for organization: ${org}`);
    
    // Get all repositories in the organization
    const repos = await octokit.paginate('GET /orgs/{org}/repos', {
      org,
      type: 'all',
      per_page: 100
    });
    
    console.log(`Found ${repos.length} repositories to synchronize`);
    
    // Process each repository
    for (const repo of repos) {
      if (repo.archived) {
        console.log(`Skipping archived repository: ${repo.full_name}`);
        continue;
      }
      
      console.log(`Processing repository: ${repo.full_name}`);
      
      // Apply configuration
      const configResult = await configureRepository(octokit, repo.owner.login, repo.name);
      
      // Apply branch protection
      if (config && config.branch_protection) {
        await applyBranchProtection(octokit, repo.owner.login, repo.name, config.branch_protection);
      }
      
      // Apply issue labels
      if (config && config.issue_labels) {
        await synchronizeIssueLabels(octokit, repo.owner.login, repo.name, config.issue_labels);
      }
      
      // Apply templates
      if (config && config.templates) {
        await applyTemplates(octokit, repo.owner.login, repo.name, config.templates);
      }
      
      // Apply Dependabot configuration
      if (config && config.dependabot) {
        await applyDependabotConfig(octokit, repo.owner.login, repo.name, config.dependabot);
      }
      
      // Apply pull request rules
      if (config && config.pull_request_rules) {
        await applyPullRequestRules(octokit, repo.owner.login, repo.name, config.pull_request_rules);
      }
      
      console.log(`✅ Synchronized ${repo.full_name}`);
    }
    
    console.log(`✅ Completed synchronization for organization: ${org}`);
    return { success: true, repositoriesProcessed: repos.length };
  } catch (error) {
    console.error(`❌ Error synchronizing repositories:`, error.message);
    return { success: false, error: error.message };
  }
}

// Function to synchronize issue labels
async function synchronizeIssueLabels(octokit, owner, repo, targetLabels) {
  try {
    console.log(`Synchronizing labels for ${owner}/${repo}`);
    
    // Get current labels
    const currentLabels = await octokit.paginate('GET /repos/{owner}/{repo}/labels', {
      owner,
      repo,
      per_page: 100
    });
    
    // Create or update labels
    for (const targetLabel of targetLabels) {
      const existingLabel = currentLabels.find(l => l.name === targetLabel.name);
      
      if (existingLabel) {
        // Update existing label if needed
        if (existingLabel.color !== targetLabel.color || 
            existingLabel.description !== targetLabel.description) {
          await octokit.request('PATCH /repos/{owner}/{repo}/labels/{name}', {
            owner,
            repo,
            name: targetLabel.name,
            color: targetLabel.color,
            description: targetLabel.description
          });
          console.log(`Updated label: ${targetLabel.name}`);
        }
      } else {
        // Create new label
        await octokit.request('POST /repos/{owner}/{repo}/labels', {
          owner,
          repo,
          name: targetLabel.name,
          color: targetLabel.color,
          description: targetLabel.description
        });
        console.log(`Created label: ${targetLabel.name}`);
      }
    }
    
    // Remove labels that are not in target configuration
    for (const currentLabel of currentLabels) {
      if (!targetLabels.some(tl => tl.name === currentLabel.name)) {
        await octokit.request('DELETE /repos/{owner}/{repo}/labels/{name}', {
          owner,
          repo,
          name: currentLabel.name
        });
        console.log(`Removed label: ${currentLabel.name}`);
      }
    }
    
    console.log(`✅ Synchronized labels for ${owner}/${repo}`);
  } catch (error) {
    console.error(`❌ Error synchronizing labels for ${owner}/${repo}:`, error.message);
    throw error;
  }
}

// Function to apply pull request rules
async function applyPullRequestRules(octokit, owner, repo, prRules) {
  try {
    console.log(`Applying PR rules to ${owner}/${repo}`);
    
    // Apply branch protection which includes PR rules
    await octokit.request('PUT /repos/{owner}/{repo}/branches/{branch}/protection', {
      owner,
      repo,
      branch: 'main',
      required_pull_request_reviews: {
        required_approving_review_count: prRules.required_approving_reviews,
        dismiss_stale_reviews: prRules.dismiss_stale_reviews,
        require_code_owner_reviews: prRules.require_code_owner_reviews,
        require_last_push_approval: prRules.require_last_push_approval
      },
      required_status_checks: {
        strict: true,
        contexts: prRules.required_status_checks
      }
    });
    
    console.log(`✅ Applied PR rules to ${owner}/${repo}`);
  } catch (error) {
    console.error(`❌ Error applying PR rules to ${owner}/${repo}:`, error.message);
    throw error;
  }
}

// Function to handle signed commit merges
async function handleSignedCommitMerge(octokit, owner, repo, prNumber) {
  try {
    console.log(`Handling signed commit merge for ${owner}/${repo} PR #${prNumber}`);
    
    // Check if this PR has signed commits
    const prCommits = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
      owner,
      repo,
      pull_number: prNumber
    });
    
    const hasSignedCommits = prCommits.data.some(commit => 
      commit.commit.verification && commit.commit.verification.verified
    );
    
    if (hasSignedCommits) {
      console.log(`✅ PR #${prNumber} contains signed commits`);
      
      // Get current branch protection
      const currentProtection = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
        owner,
        repo,
        branch: 'main'
      });
      
      // Check if we need to temporarily allow merge commits
      const allowsMergeCommits = currentProtection.data.allow_merge_commit;
      
      if (!allowsMergeCommits) {
        console.log('⚠️  Branch protection blocks merge commits, temporarily allowing...');
        
        // Temporarily allow merge commits
        await octokit.request('PATCH /repos/{owner}/{repo}/branches/{branch}/protection', {
          owner,
          repo,
          branch: 'main',
          allow_merge_commit: true
        });
        
        console.log('✅ Temporarily allowed merge commits for signed commit preservation');
        
        // Schedule re-enforcement of rebase-only
        setTimeout(async () => {
          try {
            await octokit.request('PATCH /repos/{owner}/{repo}/branches/{branch}/protection', {
              owner,
              repo,
              branch: 'main',
              allow_merge_commit: false
            });
            console.log('⏳ Re-enabled rebase-only merge after timeout');
          } catch (error) {
            console.error('❌ Failed to restore branch protection:', error.message);
          }
        }, config.signed_commit_strategy?.temporary_rule_timeout || 3600000);
        
        return {
          success: true,
          action: 'temporarily_allowed_merge_commits',
          message: 'Branch protection temporarily modified to allow merge commits for signed commit preservation. Will restore rebase-only after 1 hour.'
        };
      } else {
        return {
          success: true,
          action: 'no_change_needed',
          message: 'Branch already allows merge commits, no changes needed.'
        };
      }
    } else {
      console.log(`ℹ️  PR #${prNumber} has no signed commits, using normal merge strategy`);
      return {
        success: true,
        action: 'no_signed_commits',
        message: 'No signed commits detected, proceeding with normal merge strategy.'
      };
    }
  } catch (error) {
    console.error(`❌ Error handling signed commit merge for ${owner}/${repo} PR #${prNumber}:`, error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// Function to check PR for merge strategy
async function checkPRMergeStrategy(octokit, owner, repo, prNumber) {
  try {
    console.log(`Checking merge strategy for ${owner}/${repo} PR #${prNumber}`);
    
    // Get PR details
    const prDetails = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: prNumber
    });
    
    // Check branch protection
    const branchProtection = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
      owner,
      repo,
      branch: prDetails.data.base.ref
    });
    
    // Check commits
    const commits = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
      owner,
      repo,
      pull_number: prNumber
    });
    
    const hasSignedCommits = commits.data.some(commit => 
      commit.commit.verification && commit.commit.verification.verified
    );
    
    return {
      prTitle: prDetails.data.title,
      baseBranch: prDetails.data.base.ref,
      hasSignedCommits,
      currentMergeStrategy: {
        allowMergeCommit: branchProtection.data.allow_merge_commit,
        allowSquashMerge: branchProtection.data.allow_squash_merge,
        allowRebaseMerge: branchProtection.data.allow_rebase_merge
      },
      commitCount: commits.data.length,
      signedCommitCount: commits.data.filter(c => c.commit.verification?.verified).length
    };
  } catch (error) {
    console.error(`❌ Error checking PR merge strategy:`, error.message);
    return {
      error: error.message
    };
  }
}

// Function to verify CI attestation rules
async function verifyCIAttestation(octokit, owner, repo, ciConfig) {
  try {
    console.log(`Verifying CI attestation for ${owner}/${repo}`);
    
    // Check if required checks exist
    const branchProtection = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
      owner,
      repo,
      branch: 'main'
    });
    
    const requiredChecks = branchProtection.data.required_status_checks.contexts || [];
    const missingChecks = ciConfig.required_checks.filter(check => !requiredChecks.includes(check));
    
    if (missingChecks.length > 0) {
      console.warn(`Missing required CI checks: ${missingChecks.join(', ')}`);
      return { compliant: false, missingChecks };
    }
    
    console.log(`✅ CI attestation verified for ${owner}/${repo}`);
    return { compliant: true };
  } catch (error) {
    console.error(`❌ Error verifying CI attestation for ${owner}/${repo}:`, error.message);
    return { compliant: false, error: error.message };
  }
}

// Function to apply Dependabot configuration
async function applyDependabotConfig(octokit, owner, repo, dependabotConfig) {
  try {
    console.log(`Applying Dependabot configuration to ${owner}/${repo}`);
    
    // Check if we should use PR-based changes
    const usePR = config.change_strategy?.use_pull_requests || false;
    
    if (usePR) {
      // Create a branch and PR for the configuration change
      await createConfigurationPR(octokit, owner, repo, 'dependabot.yml', 
        jsyaml.dump(dependabotConfig), 'Update Dependabot configuration');
    } else {
      // Direct application (current behavior)
      // Create .github directory if it doesn't exist
      try {
        await octokit.request('PUT /repos/{owner}/{repo}/contents/.github', {
          owner,
          repo,
          path: '.github',
          message: 'Create .github directory'
        });
      } catch (error) {
        // Directory already exists, continue
        if (error.status !== 409) {
          throw error;
        }
      }
      
      // Convert Dependabot config to YAML
      const yamlContent = jsyaml.dump(dependabotConfig);
      
      // Create or update dependabot.yml
      await octokit.request('PUT /repos/{owner}/{repo}/contents/.github/dependabot.yml', {
        owner,
        repo,
        path: '.github/dependabot.yml',
        message: 'Add/Update Dependabot configuration',
        content: Buffer.from(yamlContent).toString('base64')
      });
    }
    
    console.log(`✅ Applied Dependabot configuration to ${owner}/${repo}`);
  } catch (error) {
    console.error(`❌ Error applying Dependabot configuration to ${owner}/${repo}:`, error.message);
    throw error;
  }
}

// Function to create configuration PR
async function createConfigurationPR(octokit, owner, repo, filePath, fileContent, commitMessage) {
  try {
    console.log(`Creating configuration PR for ${owner}/${repo} - ${filePath}`);
    
    // Get current repository info
    const repoInfo = await octokit.request('GET /repos/{owner}/{repo}', {
      owner,
      repo
    });
    
    // Create a unique branch name
    const branchName = `bot/config-update-${Date.now()}`;
    
    // Get the current ref
    const mainRef = await octokit.request('GET /repos/{owner}/{repo}/git/ref/heads/main', {
      owner,
      repo
    });
    
    // Create a new branch
    await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: mainRef.data.object.sha
    });
    
    // Create the file in the new branch
    await octokit.request('PUT /repos/{owner}/{repo}/contents/.github/${filePath}', {
      owner,
      repo,
      path: `.github/${filePath}`,
      message: commitMessage,
      content: Buffer.from(fileContent).toString('base64'),
      branch: branchName
    });
    
    // Create the PR
    const pr = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
      owner,
      repo,
      title: config.change_strategy?.pr_title || '[Bot] Configuration Update',
      head: branchName,
      base: 'main',
      body: config.change_strategy?.pr_body || 'Automated configuration update',
      maintainer_can_modify: true
    });
    
    // Add labels if configured
    if (config.change_strategy?.pr_labels && config.change_strategy.pr_labels.length > 0) {
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner,
        repo,
        issue_number: pr.data.number,
        labels: config.change_strategy.pr_labels
      });
    }
    
    // Add reviewers if configured
    if (config.change_strategy?.pr_reviewers && config.change_strategy.pr_reviewers.length > 0) {
      await octokit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers', {
        owner,
        repo,
        pull_number: pr.data.number,
        reviewers: config.change_strategy.pr_reviewers
      });
    }
    
    console.log(`✅ Created configuration PR #${pr.data.number} for ${owner}/${repo}`);
    return pr.data;
  } catch (error) {
    console.error(`❌ Error creating configuration PR for ${owner}/${repo}:`, error.message);
    throw error;
  }
}

// Function to check existing Dependabot configuration before applying
async function checkExistingDependabotConfig(octokit, owner, repo) {
  try {
    console.log(`Checking existing Dependabot configuration for ${owner}/${repo}`);
    
    // Try to get current Dependabot config
    try {
      const dependabotResponse = await octokit.request('GET /repos/{owner}/{repo}/contents/.github/dependabot.yml', {
        owner,
        repo,
        path: '.github/dependabot.yml'
      });
      
      const currentConfig = jsyaml.load(Buffer.from(dependabotResponse.data.content, 'base64').toString('utf8'));
      const targetConfig = config.dependabot;
      
      // Check if labels are properly set
      const issues = await octokit.paginate('GET /repos/{owner}/{repo}/issues', {
        owner,
        repo,
        state: 'open',
        creator: 'dependabot[bot]',
        per_page: 100
      });
      
      const dependabotPRs = issues.filter(issue => issue.pull_request);
      const labelIssues = [];
      
      dependabotPRs.forEach(pr => {
        const hasDependenciesLabel = pr.labels.some(label => label.name === 'dependencies');
        const hasAutomationLabel = pr.labels.some(label => label.name === 'automation');
        
        if (!hasDependenciesLabel || !hasAutomationLabel) {
          labelIssues.push({
            number: pr.number,
            missingLabels: []
          });
          
          if (!hasDependenciesLabel) {
            labelIssues[labelIssues.length - 1].missingLabels.push('dependencies');
          }
          if (!hasAutomationLabel) {
            labelIssues[labelIssues.length - 1].missingLabels.push('automation');
          }
        }
      });
      
      return {
        exists: true,
        currentConfig,
        matchesTarget: JSON.stringify(currentConfig) === JSON.stringify(targetConfig),
        labelIssues,
        dependabotPRCount: dependabotPRs.length
      };
    } catch (error) {
      if (error.status === 404) {
        return {
          exists: false,
          currentConfig: null,
          matchesTarget: false,
          labelIssues: [],
          dependabotPRCount: 0
        };
      }
      throw error;
    }
  } catch (error) {
    console.error(`❌ Error checking existing Dependabot configuration:`, error.message);
    throw error;
  }
}

// Function to fix Dependabot PR labels
async function fixDependabotPRLabels(octokit, owner, repo, labelIssues) {
  try {
    console.log(`Fixing labels for ${labelIssues.length} Dependabot PRs in ${owner}/${repo}`);
    
    for (const issue of labelIssues) {
      await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', {
        owner,
        repo,
        issue_number: issue.number,
        labels: issue.missingLabels
      });
      console.log(`✅ Added missing labels to PR #${issue.number}: ${issue.missingLabels.join(', ')}`);
    }
    
    return { success: true, fixedIssues: labelIssues.length };
  } catch (error) {
    console.error(`❌ Error fixing Dependabot PR labels:`, error.message);
    throw error;
  }
}

// Function to generate configuration report
async function generateConfigurationReport(octokit, owner, repo) {
  try {
    console.log(`Generating configuration report for ${owner}/${repo}`);
    
    // Get current repository settings
    const repoSettings = await octokit.request('GET /repos/{owner}/{repo}', {
      owner,
      repo
    });
    
    // Get branch protection
    const branchProtection = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
      owner,
      repo,
      branch: 'main'
    });
    
    // Get current labels
    const currentLabels = await octokit.paginate('GET /repos/{owner}/{repo}/labels', {
      owner,
      repo,
      per_page: 100
    });
    
    // Try to get Dependabot config
    let dependabotConfig = null;
    try {
      const dependabotResponse = await octokit.request('GET /repos/{owner}/{repo}/contents/.github/dependabot.yml', {
        owner,
        repo,
        path: '.github/dependabot.yml'
      });
      dependabotConfig = Buffer.from(dependabotResponse.data.content, 'base64').toString('utf8');
    } catch (error) {
      dependabotConfig = 'No Dependabot configuration found';
    }
    
    // Build report
    let report = `## Configuration Report for ${owner}/${repo}\n\n`;
    
    report += '### Repository Settings\n';
    report += `- Merge Commit: ${repoSettings.data.allow_merge_commit}\n`;
    report += `- Squash Merge: ${repoSettings.data.allow_squash_merge}\n`;
    report += `- Rebase Merge: ${repoSettings.data.allow_rebase_merge}\n`;
    report += `- Delete Branch on Merge: ${repoSettings.data.delete_branch_on_merge}\n\n`;
    
    report += '### Branch Protection\n';
    if (branchProtection.data) {
      const protection = branchProtection.data;
      report += `- Required Status Checks: ${protection.required_status_checks?.contexts?.join(', ') || 'None'}\n`;
      report += `- Enforce Admins: ${protection.enforce_admins?.enabled || false}\n`;
      report += `- Required Reviews: ${protection.required_pull_request_reviews?.required_approving_review_count || 0}\n`;
      report += `- Dismiss Stale Reviews: ${protection.required_pull_request_reviews?.dismiss_stale_reviews || false}\n`;
      report += `- Require Code Owner Reviews: ${protection.required_pull_request_reviews?.require_code_owner_reviews || false}\n\n`;
    } else {
      report += '- No branch protection configured\n\n';
    }
    
    report += `### Issue Labels (${currentLabels.length})\n`;
    report += '```\n';
    currentLabels.forEach(label => {
      report += `${label.name.padEnd(20)} - ${label.color} - ${label.description || ''}\n`;
    });
    report += '```\n\n';
    
    report += '### Dependabot Configuration\n';
    report += '```yaml\n';
    report += dependabotConfig + '\n';
    report += '```\n';
    
    return report;
  } catch (error) {
    console.error(`❌ Error generating configuration report for ${owner}/${repo}:`, error.message);
    return `❌ Error generating configuration report: ${error.message}`;
  }
}

// Function to check Dependabot configuration
async function checkDependabotConfiguration(octokit, owner, repo) {
  try {
    console.log(`Checking Dependabot configuration for ${owner}/${repo}`);
    
    // Try to get current Dependabot config
    try {
      const dependabotResponse = await octokit.request('GET /repos/{owner}/{repo}/contents/.github/dependabot.yml', {
        owner,
        repo,
        path: '.github/dependabot.yml'
      });
      
      const currentConfig = jsyaml.load(Buffer.from(dependabotResponse.data.content, 'base64').toString('utf8'));
      const targetConfig = config.dependabot;
      
      // Check existing Dependabot config with label verification
      const dependabotCheck = await checkExistingDependabotConfig(octokit, owner, repo);
      
      // Compare configurations
      let report = `## Dependabot Configuration Check for ${owner}/${repo}\n\n`;
      
      if (!currentConfig) {
        report += '❌ No Dependabot configuration found. Target configuration should be applied.\n';
      } else {
        report += '### Current Configuration\n';
        report += '```yaml\n';
        report += jsyaml.dump(currentConfig) + '\n';
        report += '```\n\n';
        
        report += '### Target Configuration\n';
        report += '```yaml\n';
        report += jsyaml.dump(targetConfig) + '\n';
        report += '```\n\n';
        
        // Simple comparison
        if (JSON.stringify(currentConfig) === JSON.stringify(targetConfig)) {
          report += '✅ Dependabot configuration matches target!\n';
        } else {
          report += '⚠️  Dependabot configuration differs from target. Consider running /configure-repo to update.\n';
        }
      }
      
      // Add label check results
      report += '\n### Dependabot PR Label Analysis\n';
      if (dependabotCheck.labelIssues.length > 0) {
        report += `⚠️  Found ${dependabotCheck.labelIssues.length} Dependabot PRs with missing labels:\n`;
        dependabotCheck.labelIssues.forEach(issue => {
          report += `- PR #${issue.number}: Missing labels: ${issue.missingLabels.join(', ')}\n`;
        });
        report += '\nRun `/fix-dependabot-labels` to automatically fix these issues.\n';
      } else {
        report += '✅ All Dependabot PRs have correct labels.\n';
      }
      
      return report;
    } catch (error) {
      if (error.status === 404) {
        return `❌ No Dependabot configuration found in ${owner}/${repo}. Target configuration should be applied.`;
      }
      throw error;
    }
  } catch (error) {
    console.error(`❌ Error checking Dependabot configuration for ${owner}/${repo}:`, error.message);
    return `❌ Error checking Dependabot configuration: ${error.message}`;
  }
}

// Function to analyze all repositories in organization
async function analyzeOrganizationRepositories(octokit, org) {
  try {
    console.log(`Analyzing all repositories in organization: ${org}`);
    
    // Get all repositories in the organization
    const repos = await octokit.paginate('GET /orgs/{org}/repos', {
      org,
      type: 'all',
      per_page: 100
    });
    
    console.log(`Found ${repos.length} repositories to analyze`);
    
    // Filter out forks
    const nonForkRepos = repos.filter(repo => !repo.fork);
    console.log(`Analyzing ${nonForkRepos.length} non-fork repositories`);
    
    // Analyze each repository
    const analysisResults = [];
    
    for (const repo of nonForkRepos) {
      if (repo.archived) {
        console.log(`Skipping archived repository: ${repo.full_name}`);
        continue;
      }
      
      console.log(`Analyzing repository: ${repo.full_name}`);
      
      const repoAnalysis = {
        name: repo.name,
        full_name: repo.full_name,
        created_at: repo.created_at,
        updated_at: repo.updated_at,
        size: repo.size,
        stargazers_count: repo.stargazers_count,
        forks_count: repo.forks_count,
        open_issues_count: repo.open_issues_count,
        has_issues: repo.has_issues,
        has_projects: repo.has_projects,
        has_wiki: repo.has_wiki,
        configurations: {}
      };
      
      // Check repository settings
      try {
        const repoSettings = await octokit.request('GET /repos/{owner}/{repo}', {
          owner: repo.owner.login,
          repo: repo.name
        });
        
        repoAnalysis.configurations.merge_settings = {
          allow_merge_commit: repoSettings.data.allow_merge_commit,
          allow_squash_merge: repoSettings.data.allow_squash_merge,
          allow_rebase_merge: repoSettings.data.allow_rebase_merge,
          delete_branch_on_merge: repoSettings.data.delete_branch_on_merge
        };
      } catch (error) {
        console.error(`Error getting settings for ${repo.full_name}:`, error.message);
        repoAnalysis.configurations.merge_settings = { error: error.message };
      }
      
      // Check branch protection
      try {
        const branchProtection = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}/protection', {
          owner: repo.owner.login,
          repo: repo.name,
          branch: 'main'
        });
        
        repoAnalysis.configurations.branch_protection = {
          exists: true,
          required_status_checks: branchProtection.data.required_status_checks?.contexts || [],
          enforce_admins: branchProtection.data.enforce_admins?.enabled || false,
          required_reviews: branchProtection.data.required_pull_request_reviews?.required_approving_review_count || 0
        };
      } catch (error) {
        if (error.status === 404) {
          repoAnalysis.configurations.branch_protection = { exists: false };
        } else {
          console.error(`Error getting branch protection for ${repo.full_name}:`, error.message);
          repoAnalysis.configurations.branch_protection = { error: error.message };
        }
      }
      
      // Check Dependabot configuration
      try {
        const dependabotCheck = await checkExistingDependabotConfig(octokit, repo.owner.login, repo.name);
        repoAnalysis.configurations.dependabot = {
          exists: dependabotCheck.exists,
          matches_target: dependabotCheck.matchesTarget,
          pr_count: dependabotCheck.dependabotPRCount,
          label_issues: dependabotCheck.labelIssues.length
        };
      } catch (error) {
        console.error(`Error checking Dependabot for ${repo.full_name}:`, error.message);
        repoAnalysis.configurations.dependabot = { error: error.message };
      }
      
      // Check issue labels
      try {
        const currentLabels = await octokit.paginate('GET /repos/{owner}/{repo}/labels', {
          owner: repo.owner.login,
          repo: repo.name,
          per_page: 100
        });
        
        repoAnalysis.configurations.labels = {
          count: currentLabels.length,
          standard_labels: currentLabels.filter(label => 
            config.issue_labels.some(target => target.name === label.name)
          ).map(label => label.name)
        };
      } catch (error) {
        console.error(`Error checking labels for ${repo.full_name}:`, error.message);
        repoAnalysis.configurations.labels = { error: error.message };
      }
      
      analysisResults.push(repoAnalysis);
    }
    
    console.log(`✅ Completed analysis for organization: ${org}`);
    return { success: true, repositories: analysisResults };
  } catch (error) {
    console.error(`❌ Error analyzing organization repositories:`, error.message);
    return { success: false, error: error.message };
  }
}

// Function to generate organization-wide analysis report
async function generateOrganizationAnalysisReport(octokit, org) {
  try {
    const analysis = await analyzeOrganizationRepositories(octokit, org);
    
    if (!analysis.success) {
      return `❌ Error analyzing organization: ${analysis.error}`;
    }
    
    const repos = analysis.repositories;
    
    let report = `# Organization Repository Analysis Report\n\n`;
    report += `## Summary\n\n`;
    report += `- Total Repositories: ${repos.length}\n`;
    
    // Count configurations
    const withBranchProtection = repos.filter(r => r.configurations.branch_protection?.exists);
    const withDependabot = repos.filter(r => r.configurations.dependabot?.exists);
    const withStandardLabels = repos.filter(r => 
      r.configurations.labels?.standard_labels?.length >= config.issue_labels.length / 2
    );
    
    report += `- With Branch Protection: ${withBranchProtection.length}\n`;
    report += `- With Dependabot Config: ${withDependabot.length}\n`;
    report += `- With Standard Labels: ${withStandardLabels.length}\n\n`;
    
    // Merge settings analysis
    const correctMergeSettings = repos.filter(r => 
      r.configurations.merge_settings?.allow_merge_commit === false &&
      r.configurations.merge_settings?.allow_squash_merge === false &&
      r.configurations.merge_settings?.allow_rebase_merge === true &&
      r.configurations.merge_settings?.delete_branch_on_merge === true
    );
    
    report += `- With Correct Merge Settings: ${correctMergeSettings.length}\n\n`;
    
    // Dependabot analysis
    const dependabotLabelIssues = repos.reduce((sum, r) => 
      sum + (r.configurations.dependabot?.label_issues || 0), 0
    );
    
    report += `- Dependabot PRs with Label Issues: ${dependabotLabelIssues}\n\n`;
    
    report += `## Detailed Repository Analysis\n\n`;
    
    // Sort by most recently updated
    repos.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    
    repos.forEach(repo => {
      report += `### ${repo.full_name}\n\n`;
      report += `- Created: ${repo.created_at} | Updated: ${repo.updated_at}\n`;
      report += `- Size: ${repo.size} KB | Stars: ${repo.stargazers_count} | Forks: ${repo.forks_count}\n`;
      report += `- Open Issues: ${repo.open_issues_count}\n\n`;
      
      report += `#### Merge Settings\n`;
      const mergeSettings = repo.configurations.merge_settings;
      if (mergeSettings.error) {
        report += `- ❌ Error: ${mergeSettings.error}\n`;
      } else {
        report += `- Merge Commit: ${mergeSettings.allow_merge_commit ? '❌ Enabled' : '✅ Disabled'}\n`;
        report += `- Squash Merge: ${mergeSettings.allow_squash_merge ? '❌ Enabled' : '✅ Disabled'}\n`;
        report += `- Rebase Merge: ${mergeSettings.allow_rebase_merge ? '✅ Enabled' : '❌ Disabled'}\n`;
        report += `- Delete Branch: ${mergeSettings.delete_branch_on_merge ? '✅ Enabled' : '❌ Disabled'}\n`;
      }
      report += '\n';
      
      report += `#### Branch Protection\n`;
      const branchProtection = repo.configurations.branch_protection;
      if (branchProtection.exists) {
        report += `- ✅ Branch protection enabled\n`;
        report += `- Required Checks: ${branchProtection.required_status_checks.join(', ') || 'None'}\n`;
        report += `- Enforce Admins: ${branchProtection.enforce_admins ? '✅ Yes' : '❌ No'}\n`;
        report += `- Required Reviews: ${branchProtection.required_reviews}\n`;
      } else if (branchProtection.exists === false) {
        report += `- ❌ No branch protection configured\n`;
      } else {
        report += `- ❌ Error: ${branchProtection.error}\n`;
      }
      report += '\n';
      
      report += `#### Dependabot\n`;
      const dependabot = repo.configurations.dependabot;
      if (dependabot.exists) {
        report += `- ✅ Dependabot config exists\n`;
        report += `- Matches Target: ${dependabot.matches_target ? '✅ Yes' : '❌ No'}\n`;
        report += `- Open PRs: ${dependabot.pr_count}\n`;
        if (dependabot.label_issues > 0) {
          report += `- ⚠️  ${dependabot.label_issues} PRs with label issues\n`;
        }
      } else if (dependabot.exists === false) {
        report += `- ❌ No Dependabot configuration\n`;
      } else {
        report += `- ❌ Error: ${dependabot.error}\n`;
      }
      report += '\n';
      
      report += `#### Labels\n`;
      const labels = repo.configurations.labels;
      if (labels.count !== undefined) {
        report += `- Total Labels: ${labels.count}\n`;
        report += `- Standard Labels: ${labels.standard_labels?.length || 0}/${config.issue_labels.length}\n`;
        
        const missingStandardLabels = config.issue_labels.filter(
          target => !labels.standard_labels?.includes(target.name)
        );
        
        if (missingStandardLabels.length > 0) {
          report += `- Missing Standard Labels: ${missingStandardLabels.map(l => l.name).join(', ')}\n`;
        }
      } else {
        report += `- ❌ Error: ${labels.error}\n`;
      }
      report += '\n---\n\n';
    });
    
    report += `## Recommendations\n\n`;
    
    if (correctMergeSettings.length < repos.length) {
      report += `- 🔧 Standardize merge settings across all repositories\n`;
    }
    
    if (withBranchProtection.length < repos.length) {
      report += `- 🛡️  Enable branch protection on ${repos.length - withBranchProtection.length} repositories\n`;
    }
    
    if (withDependabot.length < repos.length) {
      report += `- 🤖 Add Dependabot configuration to ${repos.length - withDependabot.length} repositories\n`;
    }
    
    if (dependabotLabelIssues > 0) {
      report += `- 🏷️  Fix label issues on ${dependabotLabelIssues} Dependabot PRs\n`;
    }
    
    if (withStandardLabels.length < repos.length) {
      report += `- 📋 Standardize labels across all repositories\n`;
    }
    
    report += `\n## Next Steps\n\n`;
    report += `- Run \\\`/sync-all-repos\\\` to apply standard configurations\n`;
    report += `- Run \\\`/analyze-org\\\` to get updated analysis after changes\n`;
    report += `- Review and merge configuration PRs created by the bot\n`;
    
    return report;
  } catch (error) {
    console.error(`❌ Error generating organization analysis report:`, error.message);
    return `❌ Error generating report: ${error.message}`;
  }
}

// Add health check endpoint
probot.server.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Add webhook verification endpoint
probot.server.get('/webhook', (req, res) => {
  res.status(200).json({
    message: 'Webhook endpoint ready',
    events: ['repository', 'issue_comment', 'pull_request', 'push']
  });
});

// Enhanced error handling
probot.on('error', (error) => {
  console.error('Probot error:', error);
  // Add your error reporting here (Sentry, etc.)
});

// Start the Probot server with enhanced logging
(async () => {
  try {
    console.log('Starting Probot Repository Configurator...');
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`Port: ${process.env.PORT || 3000}`);
    
    // Check environment type
    if (process.env.HETZNER_ENVIRONMENT) {
      console.log('🔧 Running in Hetzner environment');
      console.log('📦 Using Hetzner server configuration');
    } else if (process.env.NETCUP_ENVIRONMENT) {
      console.log('🔧 Running in Netcup environment');
      console.log('📦 Using shared hosting configuration');
    } else {
      console.log('🔧 Running in generic environment');
    }
    
    await probot.load();
    console.log('✅ Probot app loaded successfully');
    
    await probot.start();
    console.log('✅ Probot app started');
    console.log('🚀 Ready to process GitHub events!');
    
    // Log available endpoints
    console.log('📡 Health check: GET /health');
    console.log('📡 Webhook: POST /api/github/webhooks');
    console.log('📡 Webhook info: GET /webhook');
    
    // Environment-specific logging
    if (process.env.HETZNER_ENVIRONMENT) {
      console.log('💡 Hetzner Tip: Check Nginx proxy configuration');
      console.log('💡 Hetzner Tip: Verify firewall allows port 80/443');
    } else if (process.env.NETCUP_ENVIRONMENT) {
      console.log('💡 Netcup Tip: Make sure your .htaccess is properly configured');
      console.log('💡 Netcup Tip: Check that port 3000 is allowed in your hosting');
    }
  } catch (error) {
    console.error('❌ Error starting Probot:', error);
    
    // Environment-specific error handling
    if (error.code === 'EADDRINUSE') {
      console.error('🔥 Port 3000 is already in use. Check other Node.js processes.');
    }
    
    if (error.message.includes('permission')) {
      console.error('🔒 Permission error. Check file permissions.');
    }
    
    if (error.message.includes('ENOENT')) {
      console.error('📁 File not found. Check application files are present.');
    }
    
    process.exit(1);
  }
})();
