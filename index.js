const { Probot } = require('probot');
const { Octokit } = require('@octokit/rest');

// Initialize the Probot app
const probot = new Probot({
  // GitHub App credentials will be loaded from environment variables
});

// Configuration settings
const TARGET_SETTINGS = {
  allow_merge_commit: false,
  allow_squash_merge: false,
  allow_rebase_merge: true,
  delete_branch_on_merge: true
};

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
    
    console.log(`✅ Successfully configured ${owner}/${repo}`);
    return { success: true };
  } catch (error) {
    console.error(`❌ Error configuring ${owner}/${repo}:`, error.message);
    return { success: false, error: error.message };
  }
}

// Listen for new repository creation events
probot.on('repository.created', async (context) => {
  const { repository, organization } = context.payload;
  
  // Only process repositories in the pulseengine organization
  if (organization && organization.login === 'pulseengine') {
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
  
  // Check if this is a configuration command
  if (comment.body.trim() === '/configure-repo' &&
      context.payload.sender.login === 'avrabe') { // Only allow you to trigger
    
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
  }
});

// Start the Probot server
(async () => {
  try {
    await probot.load();
    console.log('Probot app loaded successfully');
    await probot.start();
    console.log('Probot app started');
  } catch (error) {
    console.error('Error starting Probot:', error);
    process.exit(1);
  }
})();
