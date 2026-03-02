export function normalizeRepoInput(repoOrOwner, maybeRepo) {
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

export function getDefaultBranch(repoInfo) {
  return repoInfo?.default_branch || 'main';
}

export function isForkRepo(repoInfo) {
  return Boolean(repoInfo?.fork);
}
