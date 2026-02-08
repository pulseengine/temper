'use strict';

function normalizeRepoInput(repoOrOwner, maybeRepo) {
  if (typeof repoOrOwner === 'string') {
    return {
      name: maybeRepo,
      owner: { login: repoOrOwner },
      default_branch: 'main',
      fork: false
    };
  }

  return repoOrOwner;
}

function getDefaultBranch(repoInfo) {
  return repoInfo?.default_branch || 'main';
}

function isForkRepo(repoInfo) {
  return Boolean(repoInfo?.fork);
}

module.exports = {
  normalizeRepoInput,
  getDefaultBranch,
  isForkRepo
};
