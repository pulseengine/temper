# Netcup Webhosting 1000 NUE Deployment Guide

## 🎯 Prerequisites

- Netcup Webhosting 1000 NUE account
- Domain pointing to your Netcup hosting
- SSH access to your Netcup server
- Node.js enabled in your Netcup control panel

## 🚀 Deployment Steps

### 1. Prepare Your Environment

```bash
# Connect to your Netcup server via SSH
ssh your-username@your-server.netcup.net

# Navigate to your web directory
cd /home/your-username/www
```

### 2. Clone the Repository

```bash
# Clone the repository
git clone https://github.com/avrabe/probot-repo-configurator.git
cd probot-repo-configurator
```

### 3. Install Dependencies

```bash
# Install production dependencies only
npm install --production
```

### 4. Configure Environment Variables

```bash
# Create .env file
nano .env
```

Add the following (replace with your actual values):
```env
GITHUB_APP_ID=your_github_app_id
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nYourPrivateKeyContent\n-----END RSA PRIVATE KEY-----"
GITHUB_WEBHOOK_SECRET=your_webhook_secret_here
PORT=3000
NODE_ENV=production
NETCUP_ENVIRONMENT=true
```

### 5. Configure Apache Reverse Proxy

Create or edit your `.htaccess` file:

```apache
<IfModule mod_rewrite.c>
    RewriteEngine On
    
    # Proxy webhook requests to Node.js app
    RewriteCond %{REQUEST_URI} ^/api/github/webhooks [NC]
    RewriteRule ^(.*) http://localhost:3000/$1 [P,L]
    
    # Proxy health check
    RewriteCond %{REQUEST_URI} ^/health [NC]
    RewriteRule ^(.*) http://localhost:3000/$1 [P,L]
    
    # Proxy webhook info
    RewriteCond %{REQUEST_URI} ^/webhook [NC]
    RewriteRule ^(.*) http://localhost:3000/$1 [P,L]
    
    # Optional: Block direct access to Node.js files
    RewriteRule ^(index\.js|package\.json|node_modules) - [F,L]
</IfModule>
```

### 6. Set Up SSL Certificate

1. Go to your Netcup control panel
2. Navigate to SSL/TLS section
3. Request a free Let's Encrypt certificate
4. Install it for your domain

### 7. Start the Application

```bash
# Start the application
node index.js &

# To stop the application
pkill -f "node index.js"
```

### 8. Set Up Process Management (Optional)

For better reliability, you can use a simple bash script to monitor the process:

```bash
# Create a monitor script
nano monitor-probot.sh
```

```bash
#!/bin/bash

while true; do
    if ! pgrep -f "node index.js" > /dev/null; then
        echo "Probot app crashed, restarting..." >> /home/your-username/probot.log
        cd /home/your-username/www/probot-repo-configurator
        node index.js >> /home/your-username/probot.log 2>&1 &
    fi
    sleep 60
 done
```

```bash
# Make it executable
chmod +x monitor-probot.sh

# Start the monitor
nohup ./monitor-probot.sh > /dev/null 2>&1 &
```

### 9. Configure GitHub App

1. Go to your GitHub App settings
2. Set the Webhook URL to: `https://your-domain.com/`
3. Set the Webhook Secret to match your `.env` file
4. Select the required events:
   - ✅ Repository events
   - ✅ Issue comment events
   - ✅ Pull request events
   - ✅ Push events

### 10. Test the Deployment

```bash
# Test health endpoint
curl https://your-domain.com/health

# Test webhook info endpoint
curl https://your-domain.com/webhook
```

## 🔧 Troubleshooting

### Common Issues and Solutions

**Issue: Port 3000 already in use**
```bash
# Find and kill the process
lsof -i :3000
kill -9 PID
```

**Issue: 502 Bad Gateway**
- Check that Node.js is running
- Verify `.htaccess` proxy rules
- Check Netcup error logs

**Issue: Webhook not received**
- Verify GitHub App webhook URL
- Check that SSL certificate is valid
- Test with `curl` to verify endpoint works

**Issue: Permission denied**
```bash
# Fix file permissions
chmod -R 755 /home/your-username/www/probot-repo-configurator
chown -R your-username:www-data /home/your-username/www/probot-repo-configurator
```

## 📋 Netcup-Specific Notes

### File Permissions
Netcup uses specific user/group permissions. Make sure:
- Files are owned by your user
- Web server (www-data) has read access
- Node.js process has write access to necessary files

### Process Limits
Netcup shared hosting has process limits. Be aware of:
- Memory limits
- CPU usage limits
- Process count limits

### Logging
Check Netcup's error logs in the control panel for:
- Apache errors
- Node.js crashes
- Permission issues

## 🎉 Success!

Your Probot Repository Configurator should now be:
- ✅ Running on your Netcup hosting
- ✅ Receiving GitHub webhooks
- ✅ Processing repository events
- ✅ Ready for production use

## 🚀 Next Steps

1. **Test all commands** in a test repository
2. **Run organization analysis** `/analyze-org`
3. **Apply configurations** `/sync-all-repos`
4. **Set up monitoring** for the application
5. **Document** your deployment for future reference