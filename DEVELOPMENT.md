# Development Guide

## 🎯 Setting Up Development Environment

### Prerequisites

- Node.js 16+ (LTS recommended)
- npm or yarn
- Git
- GitHub CLI (optional but recommended)

### Installation

```bash
# Clone the repository
git clone https://github.com/avrabe/probot-repo-configurator.git
cd probot-repo-configurator

# Install dependencies
npm install

# Install development dependencies
npm install --save-dev nodemon
```

### Environment Setup

```bash
# Copy example environment file
cp .env.example .env

# Edit .env with your GitHub App credentials
nano .env
```

### Running the Bot

```bash
# Start in development mode (auto-restart on changes)
npm run dev

# Or start in production mode
npm start
```

## 🔧 Development Workflow

### Making Changes

1. **Edit the code** - Modify files in the project
2. **Test locally** - Use `npm run dev` for auto-restart
3. **Commit changes** - Use Git for version control
4. **Push to GitHub** - Deploy to your hosting provider

### Testing

#### Manual Testing

```bash
# Create a test repository
gh repo create pulseengine/test-repo --private

# Check configuration
gh api repos/pulseengine/test-repo --jq '.allow_merge_commit, .allow_squash_merge, .allow_rebase_merge, .delete_branch_on_merge'

# Clean up
gh repo delete pulseengine/test-repo --confirm
```

#### Unit Testing (Future)

```bash
# Install testing framework
npm install --save-dev jest @types/jest

# Initialize Jest
npx jest --init

# Run tests
npm test
```

### Debugging

```bash
# View logs
npm run dev

# Check GitHub API responses
DEBUG=probot* npm start

# Use curl to test webhook
curl -X POST \
  -H "X-GitHub-Event: repository" \
  -H "X-GitHub-Delivery: test" \
  -H "X-Hub-Signature: sha1=..." \
  -H "Content-Type: application/json" \
  -d @test-payload.json \
  http://localhost:3000/webhook
```

## 📦 Project Structure

```
probot-repo-configurator/
├── .env.example          # Example environment file
├── .gitignore            # Git ignore rules
├── .github/              # GitHub configuration
├── Dockerfile            # Docker configuration
├── GITHUB_APP_SETUP.md   # GitHub App setup guide
├── DEVELOPMENT.md        # This file
├── LICENSE               # MIT License
├── README.md             # Main documentation
├── config.yml            # Configuration file
├── index.js              # Main bot file
├── package.json          # Node.js configuration
└── test/                 # Test files (future)
```

## 🎛️ Configuration

### Main Configuration

Edit `config.yml` to customize bot behavior:

```yaml
organization: pulseengine
settings:
  merge:
    allow_merge_commit: false
    allow_squash_merge: false
    allow_rebase_merge: true
    delete_branch_on_merge: true
```

### Environment Variables

```
# .env file
GITHUB_APP_ID=your_app_id
GITHUB_PRIVATE_KEY=your_private_key
GITHUB_WEBHOOK_SECRET=your_webhook_secret
PORT=3000
ORGANIZATION=pulseengine
```

## 🔄 Adding New Features

### Example: Add Branch Protection

```javascript
// Add to index.js
probot.on('repository.created', async (context) => {
  // After configuring merge settings
  try {
    await context.octokit.request('PUT /repos/{owner}/{repo}/branches/{branch}/protection', {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      branch: 'main',
      required_status_checks: {
        strict: true,
        contexts: []
      },
      enforce_admins: true,
      required_pull_request_reviews: {
        required_approving_review_count: 1
      },
      restrictions: null
    });
    console.log('✅ Branch protection enabled');
  } catch (error) {
    console.error('❌ Error enabling branch protection:', error.message);
  }
});
```

### Example: Add Issue Templates

```javascript
// Add to index.js
probot.on('repository.created', async (context) => {
  // After configuring merge settings
  try {
    // Create .github directory
    await context.octokit.request('PUT /repos/{owner}/{repo}/contents/.github', {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      message: 'Create .github directory',
      content: ''
    });
    
    // Add issue template
    await context.octokit.request('PUT /repos/{owner}/{repo}/contents/.github/ISSUE_TEMPLATE.md', {
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      message: 'Add issue template',
      content: Buffer.from('# Issue Template\n\n## Description\n\n## Steps to Reproduce\n\n## Expected Behavior\n\n## Actual Behavior').toString('base64')
    });
    console.log('✅ Issue template added');
  } catch (error) {
    console.error('❌ Error adding issue template:', error.message);
  }
});
```

## 🚀 Deployment

### Local Development

```bash
npm run dev
```

### Production Deployment

#### Heroku

```bash
heroku create probot-repo-configurator
heroku config:set GITHUB_APP_ID=$(grep GITHUB_APP_ID .env | cut -d'=' -f2)
heroku config:set GITHUB_PRIVATE_KEY="$(cat private-key.pem)"
heroku config:set GITHUB_WEBHOOK_SECRET=$(grep GITHUB_WEBHOOK_SECRET .env | cut -d'=' -f2)
git push heroku main
```

#### Docker

```bash
docker build -t probot-repo-configurator .
docker run -p 3000:3000 \
  -e GITHUB_APP_ID=$(grep GITHUB_APP_ID .env | cut -d'=' -f2) \
  -e GITHUB_PRIVATE_KEY="$(cat private-key.pem)" \
  -e GITHUB_WEBHOOK_SECRET=$(grep GITHUB_WEBHOOK_SECRET .env | cut -d'=' -f2) \
  probot-repo-configurator
```

#### Server

```bash
npm install -g pm2
pm2 start index.js --name probot-repo-configurator
pm2 save
```

## 📊 Monitoring

### Logs

```bash
# View logs
pm2 logs

# Or for Docker
docker logs container_name

# Or for Heroku
heroku logs --tail
```

### Metrics (Future)

```bash
# Add Prometheus monitoring
npm install prom-client

# Add to index.js
const client = require('prom-client');
const collectDefaultMetrics = client.collectDefaultMetrics;
collectDefaultMetrics();

// Add metrics endpoint
probot.server.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});
```

## 💡 Best Practices

### Code Quality

- Use consistent indentation (2 spaces)
- Add comments for complex logic
- Keep functions small and focused
- Use async/await for promises
- Handle errors gracefully

### Security

- Never log sensitive information
- Validate all inputs
- Use environment variables for secrets
- Keep dependencies updated
- Review GitHub App permissions regularly

### Performance

- Cache API responses when possible
- Batch operations when appropriate
- Handle rate limits gracefully
- Use efficient data structures
- Avoid blocking operations

## 📚 Resources

- **Probot Documentation**: https://probot.github.io/docs/
- **Octokit Documentation**: https://octokit.github.io/rest.js/
- **GitHub API**: https://docs.github.com/en/rest
- **Node.js Best Practices**: https://github.com/goldbergyoni/nodebestpractices

## 🎉 Contributing

### Bug Reports

- Open an issue describing the problem
- Include steps to reproduce
- Include expected vs actual behavior

### Feature Requests

- Open an issue describing the feature
- Explain the use case
- Provide examples if possible

### Pull Requests

- Fork the repository
- Create a feature branch
- Write tests (when applicable)
- Update documentation
- Open a pull request

## 📝 Changelog

### 1.0.0 (Initial Release)
- Basic repository configuration
- Merge settings management
- Issue documentation
- Chatops support

### Future Releases
- Branch protection
- Issue/PR templates
- CODEOWNERS management
- Advanced monitoring
- Web dashboard

---

**Happy coding!** 🚀
