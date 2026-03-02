#!/bin/bash

echo "🔍 Netcup Deployment Verification Script"
echo "========================================"
echo ""

# Check if running on Netcup
echo "📋 Checking environment..."
if [ -f "/etc/netcup-hosting" ]; then
    echo "✅ Netcup environment detected"
else
    echo "ℹ️  Not running on Netcup (or detection failed)"
fi

echo ""
echo "📁 Checking file structure..."
if [ -f "index.js" ] && [ -f "package.json" ] && [ -f "config.yml" ]; then
    echo "✅ All required files present"
else
    echo "❌ Missing required files"
    exit 1
fi

echo ""
echo "📦 Checking Node.js dependencies..."
if [ -d "node_modules" ]; then
    echo "✅ node_modules directory exists"
else
    echo "⚠️  node_modules missing - run 'npm install --production'"
fi

echo ""
echo "🔐 Checking environment variables..."
if [ -f ".env" ]; then
    echo "✅ .env file exists"
    # Check for required variables
    if grep -q "GITHUB_APP_ID" .env && grep -q "GITHUB_PRIVATE_KEY" .env && grep -q "GITHUB_WEBHOOK_SECRET" .env; then
        echo "✅ All required environment variables present"
    else
        echo "❌ Missing required environment variables in .env"
    fi
else
    echo "❌ .env file missing"
fi

echo ""
echo "📄 Checking .htaccess configuration..."
if [ -f ".htaccess" ]; then
    echo "✅ .htaccess file exists"
    if grep -q "RewriteRule" .htaccess && grep -q "localhost:3000" .htaccess; then
        echo "✅ Proxy rules configured"
    else
        echo "⚠️  Proxy rules may be missing"
    fi
else
    echo "⚠️  .htaccess file missing - create for Apache proxy"
fi

echo ""
echo "🌐 Checking domain configuration..."
echo "Please ensure:"
echo "  - Domain points to your Netcup server"
echo "  - SSL certificate is installed"
echo "  - Webhook URL is set to https://your-domain.com/"

echo ""
echo "🚀 Ready for deployment!"
echo ""
echo "To start the application:"
echo "  node index.js &"
echo ""
echo "To test the endpoints:"
echo "  curl https://your-domain.com/health"
echo "  curl https://your-domain.com/webhook"
echo ""
echo "For troubleshooting, check:"
echo "  - Netcup error logs in control panel"
echo "  - Node.js console output"
echo "  - Apache access/error logs"
