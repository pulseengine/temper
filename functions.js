// Re-export functions for testing and external use
const {
  configureRepository,
  applyBranchProtection,
  applyTemplates,
  checkExistingDependabotConfig,
  fixDependabotPRLabels
} = require('./index');

module.exports = {
  configureRepository,
  applyBranchProtection,
  applyTemplates,
  checkExistingDependabotConfig,
  fixDependabotPRLabels
};
