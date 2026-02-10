# GitHub App Setup Guide

## Step-by-Step Guide to Setting Up the GitHub App

### Step 1: Create the GitHub App

1. **Go to GitHub App Settings**
   - Navigate to: https://github.com/organizations/pulseengine/settings/apps
   - Click "New GitHub App"

2. **Fill in App Details**
   - **GitHub App name**: `Temper`
   - **Homepage URL**: `https://github.com/pulseengine/temper`
   - **Description**: `Automatically configures repositories with standard merge settings`
   - **Callback URL**: Leave empty (not needed for this app)

3. **Set Webhook Configuration**
   - **Webhook URL**: `https://your-server-domain.com/webhook` (replace with your actual domain)
   - **Webhook Secret**: Click "Generate a new secret" and save it securely
   - **SSL verification**: Enabled (recommended)
   - **Active**: Checked

### Step 2: Configure Permissions

#### Repository Permissions
- **Contents**: Read & Write
- **Issues**: Read & Write
- **Metadata**: Read-only
- **Pull Requests**: Read & Write

#### Organization Permissions
- **Members**: Read-only
- **Metadata**: Read-only

#### User Permissions
- None required

### Step 3: Subscribe to Events

Subscribe to these events:
- **Repository** (repository.created)
- **Issue comment** (issue_comment.created)
- **Push** (optional, for future features)
- **Pull request** (optional, for future features)

### Step 4: Generate Private Key

1. Click "Generate a private key" button
2. A `.pem` file will download automatically
3. **Save this file securely** - it cannot be retrieved again!
4. Store the key in your `.env` file as `GITHUB_PRIVATE_KEY`

### Step 5: Install the App

1. Click "Install App" button
2. Select "Only select repositories" or "All repositories"
3. Choose the repositories to install on (recommend starting with a few test repos)
4. Click "Install"

### Step 6: Configure Environment Variables

Create a `.env` file in your project root:

```bash
cp .env.example .env
```

Edit the `.env` file with your actual credentials:

```
GITHUB_APP_ID=123456          # From GitHub App settings
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----..."  # Contents of .pem file
GITHUB_WEBHOOK_SECRET=your_webhook_secret_here  # From webhook setup
PORT=3000
ORGANIZATION=pulseengine
```

### Step 7: Deploy the App

Choose one of these deployment methods:

#### Option A: Local Testing
```bash
npm install
npm start
```

#### Option B: Docker
```bash
docker build -t temper .
docker run -p 3000:3000 \
  -e GITHUB_APP_ID=your_app_id \
  -e GITHUB_PRIVATE_KEY="$(cat private-key.pem)" \
  -e GITHUB_WEBHOOK_SECRET=your_webhook_secret \
  temper
```

### Step 8: Verify the App

1. **Check logs**: Ensure the app started without errors
2. **Test manually**: Create a test repository and verify it gets configured
3. **Check issues**: The bot should create a "Repository Configuration" issue

### Step 9: Monitor and Maintain

1. **Monitor logs**: Set up log monitoring
2. **Error handling**: Configure alerts for errors
3. **Updates**: Keep dependencies updated
4. **Backups**: Regularly backup your private key

## Troubleshooting

### Common Issues

#### Webhook Delivery Failures
- **Check**: Webhook URL is correct and accessible
- **Fix**: Ensure your server is running and reachable from the internet

#### Permission Errors
- **Check**: App has correct permissions
- **Fix**: Review and update permissions in GitHub App settings

#### Authentication Errors
- **Check**: Private key is correctly formatted
- **Fix**: Ensure the private key is properly copied to `.env` file

#### Rate Limiting
- **Check**: API rate limits
- **Fix**: Consider adding rate limit handling or upgrading GitHub plan

## Security Best Practices

1. **Never commit private keys** - Keep `.env` and `.pem` files out of Git
2. **Use HTTPS** - Always use HTTPS for webhook URLs
3. **Rotate secrets** - Regularly rotate webhook secrets and private keys
4. **Limit access** - Only grant necessary permissions
5. **Monitor activity** - Review app activity in GitHub settings

## Success

Your GitHub App is now set up and ready to automatically configure repositories!

## Additional Resources

- [GitHub Apps Documentation](https://docs.github.com/en/developers/apps)
- [Probot Documentation](https://probot.github.io/docs/)
- [Octokit Documentation](https://octokit.github.io/rest.js/)
