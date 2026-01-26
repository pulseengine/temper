# Hetzner Server Deployment Guide

## 🎯 Prerequisites

- Hetzner server (Cloud Server or Dedicated)
- Domain name pointing to your server
- SSH access to your server
- Basic Linux knowledge

## 🚀 Deployment Steps

### 1. Connect to Your Server

```bash
ssh root@your-hetzner-server-ip
```

### 2. Update System and Install Dependencies

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Install Node.js (LTS version)
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install other dependencies
sudo apt install -y git nginx certbot python3-certbot-nginx

# Install PM2 for process management
sudo npm install -g pm2
```

### 3. Clone the Repository

```bash
# Navigate to appropriate directory
cd /opt

# Clone the repository
git clone https://github.com/avrabe/probot-repo-configurator.git
cd probot-repo-configurator
```

### 4. Install Dependencies

```bash
# Install production dependencies
npm install --production
```

### 5. Configure Environment Variables

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
HETZNER_ENVIRONMENT=true
```

### 6. Set Up Nginx Reverse Proxy

```bash
# Create Nginx configuration
sudo nano /etc/nginx/sites-available/probot-repo-configurator
```

Add this configuration:
```nginx
server {
    listen 80;
    server_name probot.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Health check endpoint
    location /health {
        proxy_pass http://localhost:3000/health;
        proxy_set_header Host $host;
    }

    # Webhook info endpoint
    location /webhook {
        proxy_pass http://localhost:3000/webhook;
        proxy_set_header Host $host;
    }

    # Webhook endpoint
    location /api/github/webhooks {
        proxy_pass http://localhost:3000/api/github/webhooks;
        proxy_set_header Host $host;
        proxy_set_header X-GitHub-Event $http_x_github_event;
        proxy_set_header X-GitHub-Delivery $http_x_github_delivery;
        proxy_set_header X-Hub-Signature $http_x_hub_signature;
    }
}
```

```bash
# Enable the site
sudo ln -s /etc/nginx/sites-available/probot-repo-configurator /etc/nginx/sites-enabled/

# Test Nginx configuration
sudo nginx -t

# Restart Nginx
sudo systemctl restart nginx
```

### 7. Set Up SSL with Let's Encrypt

```bash
# Install SSL certificate
sudo certbot --nginx -d probot.yourdomain.com

# Set up automatic renewal
sudo certbot renew --dry-run
```

### 8. Configure Firewall

```bash
# Allow HTTP, HTTPS, and SSH
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

### 9. Start the Application

```bash
# Start with PM2
pm2 start index.js --name probot-repo-configurator

# Save PM2 process list
pm2 save

# Set up PM2 to start on boot
pm2 startup
```

### 10. Configure GitHub App

1. Go to your GitHub App settings
2. Set the Webhook URL to: `https://probot.yourdomain.com/`
3. Set the Webhook Secret to match your `.env` file
4. Select the required events:
   - ✅ Repository events
   - ✅ Issue comment events
   - ✅ Pull request events
   - ✅ Push events

## 🔧 Hetzner-Specific Optimizations

### Firewall Configuration
```bash
# Check firewall status
sudo ufw status

# Allow specific ports
sudo ufw allow 22/tcp   # SSH
sudo ufw allow 80/tcp   # HTTP
sudo ufw allow 443/tcp  # HTTPS
```

### Monitoring Setup
```bash
# Install monitoring tools
sudo apt install -y htop iotop iftop

# Check system resources
htop
```

### Backup Strategy
```bash
# Create backup script
nano backup-probot.sh
```

```bash
#!/bin/bash

# Backup script for Probot Repository Configurator
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="/opt/backups/probot_$TIMESTAMP"

mkdir -p $BACKUP_DIR

# Backup application files
cp -r /opt/probot-repo-configurator $BACKUP_DIR/

# Backup environment (without private key for security)
grep -v "GITHUB_PRIVATE_KEY" /opt/probot-repo-configurator/.env > $BACKUP_DIR/.env

# Compress backup
tar -czvf /opt/backups/probot_$TIMESTAMP.tar.gz $BACKUP_DIR

# Clean up
rm -rf $BACKUP_DIR

# Keep only last 5 backups
cd /opt/backups
ls -t | tail -n +6 | xargs rm -f
```

```bash
# Make executable
chmod +x backup-probot.sh

# Add to cron (daily backup)
(crontab -l 2>/dev/null; echo "0 2 * * * /opt/probot-repo-configurator/backup-probot.sh") | crontab -
```

## 📋 Testing Your Deployment

### Test Endpoints
```bash
# Test health endpoint
curl https://probot.yourdomain.com/health

# Test webhook info endpoint
curl https://probot.yourdomain.com/webhook
```

### Test Webhook Delivery
```bash
# Use GitHub's webhook tester or create a test event
# Check PM2 logs for webhook reception
pm2 logs probot-repo-configurator
```

### Test Bot Commands
1. Create a test repository in your organization
2. Add an issue with command `/check-config`
3. Verify the bot responds correctly

## 🔧 Troubleshooting

### Common Issues and Solutions

**Issue: Nginx 502 Bad Gateway**
```bash
# Check if Node.js app is running
pm2 list

# Check app logs
pm2 logs probot-repo-configurator

# Restart Nginx
sudo systemctl restart nginx
```

**Issue: SSL Certificate Problems**
```bash
# Test SSL renewal
sudo certbot renew --dry-run

# Check certificate status
sudo certbot certificates
```

**Issue: Webhook Not Received**
```bash
# Check GitHub App webhook settings
# Verify URL is correct
# Check Nginx error logs
sudo tail -f /var/log/nginx/error.log
```

**Issue: Port 3000 in Use**
```bash
# Find process using port
sudo lsof -i :3000

# Kill process if needed
sudo kill -9 PID
```

## 📊 Monitoring and Maintenance

### Log Rotation
```bash
# Check PM2 log management
pm2 logrotate

# View logs
pm2 logs
pm2 monit
```

### System Updates
```bash
# Regular system updates
sudo apt update && sudo apt upgrade -y

# Node.js updates
sudo npm install -g npm@latest
```

### Application Updates
```bash
# Update the application
cd /opt/probot-repo-configurator
git pull origin main
npm install --production
pm2 restart probot-repo-configurator
```

## 🎉 Success!

Your Probot Repository Configurator should now be:
- ✅ Running on your Hetzner server
- ✅ Receiving GitHub webhooks via HTTPS
- ✅ Processing repository events
- ✅ Ready for production use

## 🚀 Next Steps

1. **Test all bot commands** in a test repository
2. **Run organization analysis** `/analyze-org`
3. **Apply configurations** `/sync-all-repos`
4. **Set up monitoring** for the application
5. **Document** your deployment for future reference