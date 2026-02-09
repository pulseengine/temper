/**
 * Custom Jest resolver that handles ESM-only packages whose package.json
 * exports field only specifies an "import" condition (no CJS "require" entry).
 *
 * Jest's default resolver uses CJS resolution, which fails for these packages.
 * This resolver falls back to reading the package.json exports map and
 * resolving the "import" entry so babel-jest can transform it.
 */
const path = require('path');
const fs = require('fs');

module.exports = (request, options) => {
  try {
    return options.defaultResolver(request, options);
  } catch (error) {
    // Only attempt fallback for bare/scoped specifiers (not relative paths)
    if (request.startsWith('.') || path.isAbsolute(request)) {
      throw error;
    }

    const pkgName = request.startsWith('@')
      ? request.split('/').slice(0, 2).join('/')
      : request.split('/')[0];
    const subpath = request.slice(pkgName.length) || '.';

    // Walk up from basedir to find the package in node_modules
    let dir = options.basedir || process.cwd();
    let pkgJsonPath;
    while (dir !== path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', pkgName, 'package.json');
      if (fs.existsSync(candidate)) {
        pkgJsonPath = candidate;
        break;
      }
      dir = path.dirname(dir);
    }

    if (!pkgJsonPath) {
      throw error;
    }

    const pkgDir = path.dirname(pkgJsonPath);
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));

    if (!pkgJson.exports) {
      throw error;
    }

    const exp = pkgJson.exports[subpath];
    if (!exp) {
      throw error;
    }

    // Resolve the first usable path from the exports conditions
    const resolved =
      (typeof exp === 'string' && exp) ||
      exp?.node?.import ||
      exp?.node?.default ||
      exp?.import ||
      exp?.default;

    if (typeof resolved === 'string') {
      return path.resolve(pkgDir, resolved);
    }

    throw error;
  }
};
