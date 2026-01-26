// Export functions for testing
const { configureRepository, applyBranchProtection, applyTemplates } = require('./index');
const { checkExistingDependabotConfig, fixDependabotPRLabels } = require('./index');

module.exports = {
  configureRepository,
  applyBranchProtection,
  applyTemplates,
  checkExistingDependabotConfig,
  fixDependabotPRLabels
};