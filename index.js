import { fileURLToPath } from 'url';
import { run } from 'probot';
import { registerApp, mapLegacyEnvVars } from './src/app.js';
import { configureRepository } from './src/repository.js';
import { applyBranchProtection } from './src/branch-protection.js';
import { applyTemplates, applyCodeowners } from './src/templates.js';
import { synchronizeIssueLabels } from './src/labels.js';
import {
  checkExistingDependabotConfig,
  fixDependabotPRLabels
} from './src/dependabot.js';
import { getTargetIssueLabels } from './src/config.js';

// Named exports
export {
  registerApp,
  configureRepository,
  applyBranchProtection,
  applyTemplates,
  applyCodeowners,
  checkExistingDependabotConfig,
  fixDependabotPRLabels,
  synchronizeIssueLabels,
  getTargetIssueLabels
};

// Start the Probot server with enhanced logging
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  (async () => {
    try {
      mapLegacyEnvVars();
      console.log('Starting Probot Repository Configurator...');
      console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`Port: ${process.env.PORT || 3000}`);

      if (process.env.HETZNER_ENVIRONMENT) {
        console.log('🔧 Running in Hetzner environment');
        console.log('📦 Using Hetzner server configuration');
      } else if (process.env.NETCUP_ENVIRONMENT) {
        console.log('🔧 Running in Netcup environment');
        console.log('📦 Using shared hosting configuration');
      } else {
        console.log('🔧 Running in generic environment');
      }

      await run(registerApp);
      console.log('✅ Probot app started');
      console.log('🚀 Ready to process GitHub events!');

      console.log('📡 Health check: GET /health');
      console.log(`📡 Webhook: POST ${process.env.WEBHOOK_PATH}`);
      console.log('📡 Webhook info: GET /webhook');

      if (process.env.HETZNER_ENVIRONMENT) {
        console.log('💡 Hetzner Tip: Check Nginx proxy configuration');
        console.log('💡 Hetzner Tip: Verify firewall allows port 80/443');
      } else if (process.env.NETCUP_ENVIRONMENT) {
        console.log('💡 Netcup Tip: Make sure your .htaccess is properly configured');
        console.log('💡 Netcup Tip: Check that port 3000 is allowed in your hosting');
      }
    } catch (error) {
      console.error('❌ Error starting Probot:', error);

      if (error.code === 'EADDRINUSE') {
        console.error('🔥 Port 3000 is already in use. Check other Node.js processes.');
      }

      if (error.message?.includes('permission')) {
        console.error('🔒 Permission error. Check file permissions.');
      }

      if (error.message?.includes('ENOENT')) {
        console.error('📁 File not found. Check application files are present.');
      }

      process.exit(1);
    }
  })();
}
