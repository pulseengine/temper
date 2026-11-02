#!/bin/bash
# Netcup deployment verification.
#
# Each check exits non-zero on failure so this script can be wired into a
# post-deploy hook. (Wave-1 DevOps agent flagged the previous all-`echo`
# version as performative, Bug #33 in `docs/agent-fleet/bugs.md`.)
#
# Run from the deploy directory (`/opt/temper` on netcup) AFTER `npm ci
# --production`.

set -euo pipefail

fail() { echo "❌ $*"; exit 1; }
ok()   { echo "✅ $*"; }

echo "🔍 Netcup Deployment Verification"
echo "================================="

echo ""
echo "📁 File structure"
[ -f index.js ] && [ -f package.json ] && [ -f config.yml ] \
  || fail "missing one of: index.js / package.json / config.yml"
ok "core files present"

echo ""
echo "📦 Dependencies"
[ -d node_modules ] || fail "node_modules missing — run 'npm ci --production'"
ok "node_modules present"

echo ""
echo "🔐 Environment file"
[ -f .env ] || fail ".env missing"
for var in APP_ID PRIVATE_KEY WEBHOOK_SECRET; do
  if ! grep -qE "^${var}=" .env; then
    # Accept legacy GITHUB_-prefixed names (mapped at runtime).
    if ! grep -qE "^GITHUB_${var}=" .env; then
      fail ".env missing required variable: ${var} (or GITHUB_${var})"
    fi
  fi
done
# WEBHOOK_SECRET cannot be empty or the literal "development".
secret=$(grep -E '^(GITHUB_)?WEBHOOK_SECRET=' .env | head -1 | cut -d= -f2-)
[ -n "$secret" ] || fail "WEBHOOK_SECRET is empty"
[ "$secret" != "development" ] || fail "WEBHOOK_SECRET cannot be the literal 'development'"
ok "required env vars present and non-default"

echo ""
echo "🌐 Reverse proxy"
if [ -f .htaccess ]; then
  grep -q "RewriteRule" .htaccess && grep -q "localhost:3000" .htaccess \
    || fail ".htaccess present but missing RewriteRule → localhost:3000"
  ok ".htaccess proxy configured"
else
  echo "ℹ️  no .htaccess (skip if not using Apache)"
fi

echo ""
echo "✅ Verification complete. Start the bot:"
echo "    pm2 start npm --name temper -- start"
echo "    curl http://localhost:3000/health"
