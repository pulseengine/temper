# Probot Repository Configurator

🤖 **GitHub App for automatic repository configuration**

Automatically configures new repositories in the pulseengine organization with standard merge settings using the Probot framework.

## 🎯 Features

- ✅ **Automatic Configuration** - New repositories are configured immediately upon creation
- ✅ **Real-time Processing** - Uses GitHub webhooks for instant response
- ✅ **Chatops Support** - Configure repositories manually via `/configure-repo` command
- ✅ **Audit Logging** - All actions are logged and documented in issues
- ✅ **Extensible Architecture** - Easy to add more automation features
- ✅ **Production Ready** - Built with GitHub's official Probot framework

## 🚀 Quick Start

### Prerequisites

- Node.js 16+ (LTS recommended)
- npm or yarn
- GitHub App credentials
- Access to pulseengine organization

### Installation

```bash
# Clone this repository
git clone https://github.com/avrabe/probot-repo-configurator.git
cd probot-repo-configurator

# Install dependencies
npm install

# Start the bot
npm start
```

### Configuration

Edit `config.yml` to customize settings:

```yaml
organization: pulseengine
settings:
  merge:
    allow_merge_commit: false
    allow_squash_merge: false
    allow_rebase_merge: true
    delete_branch_on_merge: true
```

## 🔧 Usage

### Automatic Configuration

The bot automatically configures new repositories in the pulseengine organization with:

- **Rebase merges only** (no merge commits, no squash merges)
- **Branch deletion after merge** (automatic cleanup)
- **Issue documentation** (creates configuration issue in each repo)

### Manual Configuration

Add a comment to any issue in any repository:

```
/configure-repo
```

The bot will:
1. Apply standard merge settings
2. Reply with confirmation or error
3. Create a configuration issue

## 📦 Architecture

```
┌─────────────────────────────────────────────────┐
│                 GitHub Events                    │
└───────────────┬─────────────────┬───────────────┘
                │                 │                 
                ▼                 ▼                 
┌─────────────────────────────────────────────────┐
│                 Probot Framework                 │
│                                                 │
│  ┌─────────────┐    ┌───────────────────────┐  │
│  │  Webhooks   │    │  Event Handlers       │  │
│  └─────────────┘    └───────────────────────┘  │
│                                                 │
└─────────────────────────────────────────────────┘
                │                 │                 
                ▼                 ▼                 
┌─────────────────────────────────────────────────┐
│                 Octokit API                     │
│                                                 │
│  ┌─────────────┐    ┌───────────────────────┐  │
│  │  GitHub     │    │  Repository           │  │
│  │  API Calls  │    │  Configuration        │  │
│  └─────────────┘    └───────────────────────┘  │
│                                                 │
└─────────────────────────────────────────────────┘
```

## 🎛️ Configuration Options

### Merge Settings

```yaml
settings:
  merge:
    allow_merge_commit: false  # Disable merge commits
    allow_squash_merge: false # Disable squash merges  
    allow_rebase_merge: true  # Enable rebase merges
    delete_branch_on_merge: true # Delete branches after merge
```

### Branch Protection (Future)

```yaml
branch_protection:
  main:
    required_status_checks: true
    enforce_admins: true
    required_pull_request_reviews:
      required_approving_review_count: 1
```

### Templates (Future)

```yaml
templates:
  pull_request: .github/PULL_REQUEST_TEMPLATE.md
  issue: .github/ISSUE_TEMPLATE/
```

## 🚀 Deployment

### Local Development

```bash
# Install nodemon for auto-restart
npm install --save-dev nodemon

# Start in development mode
npm run dev
```

### Production Deployment

#### Option A: Heroku

```bash
# Create Heroku app
heroku create probot-repo-configurator

# Set environment variables
heroku config:set GITHUB_APP_ID=your_app_id
heroku config:set GITHUB_PRIVATE_KEY="$(cat private-key.pem)"
heroku config:set GITHUB_WEBHOOK_SECRET=your_webhook_secret

# Deploy
git push heroku main
```

#### Option B: Docker

```bash
# Build Docker image
docker build -t probot-repo-configurator .

# Run container
docker run -p 3000:3000 \
  -e GITHUB_APP_ID=your_app_id \
  -e GITHUB_PRIVATE_KEY="$(cat private-key.pem)" \
  -e GITHUB_WEBHOOK_SECRET=your_webhook_secret \
  probot-repo-configurator
```

#### Option C: Server

```bash
# Install PM2 for process management
npm install -g pm2

# Start with PM2
pm2 start index.js --name probot-repo-configurator

# Save process list
pm2 save
```

## 📋 GitHub App Setup

### Step 1: Create GitHub App

1. Go to: https://github.com/organizations/pulseengine/settings/apps
2. Click "New GitHub App"
3. Fill in app details:
   - **GitHub App name**: Probot Repository Configurator
   - **Homepage URL**: https://github.com/avrabe/probot-repo-configurator
   - **Webhook URL**: https://your-server-url/webhook
   - **Webhook Secret**: Generate a secure secret

### Step 2: Configure Permissions

**Repository permissions:**
- ✅ Contents: Read & Write
- ✅ Issues: Read & Write
- ✅ Metadata: Read-only
- ✅ Pull Requests: Read & Write

**Organization permissions:**
- ✅ Members: Read-only
- ✅ Metadata: Read-only

### Step 3: Install the App

1. Install on the pulseengine organization
2. Grant access to all repositories (or select specific ones)

### Step 4: Generate Private Key

1. Click "Generate a private key"
2. Save the `.pem` file securely
3. Set as `GITHUB_PRIVATE_KEY` environment variable

## 🔄 Event Reference

### Processed Events

| Event | Description | Action |
|-------|-------------|--------|
| `repository.created` | New repository created | Auto-configure |
| `issue_comment.created` | Comment on issue | Manual configure |

### Future Events to Add

| Event | Description | Potential Action |
|-------|-------------|------------------|
| `pull_request.opened` | PR opened | Add labels, checks |
| `push` | Code pushed | Validate settings |
| `organization.member_added` | New member | Welcome message |

## 📊 Monitoring

### Logs

```bash
# View logs
pm2 logs

# Or for Docker
docker logs container_name
```

### Metrics (Future)

```yaml
# Prometheus metrics endpoint
metrics:
  enabled: true
  port: 9090
```

## 🧪 Testing

### Manual Testing

```bash
# Create a test repository
gh repo create pulseengine/test-repo --private

# Check if it was configured
gh api repos/pulseengine/test-repo --jq '.allow_merge_commit, .allow_squash_merge, .allow_rebase_merge, .delete_branch_on_merge'
```

### Unit Testing (Future)

```bash
npm install --save-dev jest @types/jest
npx jest --init
```

## 🔧 Extending the Bot

### Add New Features

```javascript
// Add to index.js
probot.on('some.event', async (context) => {
  // Your logic here
});
```

### Example: Branch Protection

```javascript
probot.on('repository.created', async (context) => {
  // After configuring merge settings
  await context.octokit.request('PUT /repos/{owner}/{repo}/branches/{branch}/protection', {
    owner: context.payload.repository.owner.login,
    repo: context.payload.repository.name,
    branch: 'main',
    required_status_checks: null,
    enforce_admins: null,
    required_pull_request_reviews: null,
    restrictions: null
  });
});
```

## 📚 Resources

- **Probot Documentation**: https://probot.github.io/docs/
- **Octokit Documentation**: https://octokit.github.io/rest.js/
- **GitHub Apps**: https://docs.github.com/en/developers/apps
- **Probot Examples**: https://github.com/probot/examples

## 🎉 Contributing

Contributions welcome! Please open issues and pull requests.

## 📝 License

MIT License - See LICENSE file

---

**Status**: Ready for deployment  
**Organization**: pulseengine  
**Maintainer**: @avrabe
