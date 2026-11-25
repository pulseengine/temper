/**
 * Ecosystem detector — scans file paths from the GitHub Trees API
 * and returns detected package ecosystems + directories.
 */

const ECOSYSTEM_PATTERNS = [
  { ecosystem: 'npm', filenames: ['package.json'] },
  { ecosystem: 'gomod', filenames: ['go.mod'] },
  { ecosystem: 'cargo', filenames: ['Cargo.toml'] },
  { ecosystem: 'bundler', filenames: ['Gemfile'] },
  { ecosystem: 'pip', filenames: ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile'] },
  { ecosystem: 'maven', filenames: ['pom.xml'] },
  { ecosystem: 'gradle', filenames: ['build.gradle', 'build.gradle.kts'] },
  { ecosystem: 'composer', filenames: ['composer.json'] },
  { ecosystem: 'docker', filenames: ['Dockerfile'] },
  { ecosystem: 'github-actions', patterns: [/^\.github\/workflows\/.*\.ya?ml$/] , fixedDirectory: '/' },
  { ecosystem: 'mix', filenames: ['mix.exs'] },
  { ecosystem: 'pub', filenames: ['pubspec.yaml'] },
  { ecosystem: 'nuget', patterns: [/\.csproj$/] },
  { ecosystem: 'terraform', patterns: [/\.tf$/] }
];

// Directories whose manifests are test data, vendored copies or build output,
// not dependencies the repo ships: updating them would rewrite fixtures that
// are stale or vulnerable on purpose (pulseengine/plant keeps such locks
// under examples/*/fixture and ci-controls/).
const SKIPPED_SEGMENTS = new Set([
  'fixture', 'fixtures', 'testdata', 'test-data', 'ci-controls',
  'vendor', 'third_party', 'node_modules', 'target'
]);

function isSkippedPath(filePath) {
  return filePath.split('/').slice(0, -1).some((seg) => SKIPPED_SEGMENTS.has(seg));
}

/**
 * Extract the dependabot directory from a file path.
 * "packages/foo/package.json" → "/packages/foo"
 * "package.json" → "/"
 */
function extractDirectory(filePath) {
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash === -1) return '/';
  return '/' + filePath.substring(0, lastSlash);
}

/**
 * Detect ecosystems from an array of file paths.
 * @param {string[]} filePaths - file paths from the GitHub Trees API
 * @param {object} [options]
 * @param {number} [options.maxDirectoriesPerEcosystem=5] - cap per ecosystem
 * @returns {Array<{ecosystem: string, directory: string}>}
 */
function detectEcosystems(filePaths, options = {}) {
  const { maxDirectoriesPerEcosystem = 5 } = options;

  // Map: ecosystem → Set of directories
  const found = new Map();

  for (const filePath of filePaths) {
    if (isSkippedPath(filePath)) continue;
    const basename = filePath.split('/').pop();

    for (const pattern of ECOSYSTEM_PATTERNS) {
      let matched = false;

      if (pattern.filenames && pattern.filenames.includes(basename)) {
        matched = true;
      }

      if (!matched && pattern.patterns) {
        for (const regex of pattern.patterns) {
          if (regex.test(filePath)) {
            matched = true;
            break;
          }
        }
      }

      if (matched) {
        const directory = pattern.fixedDirectory || extractDirectory(filePath);
        if (!found.has(pattern.ecosystem)) {
          found.set(pattern.ecosystem, new Set());
        }
        found.get(pattern.ecosystem).add(directory);
      }
    }
  }

  // Flatten, deduplicate, and cap per ecosystem (prefer shallower paths)
  const results = [];
  for (const [ecosystem, dirs] of found) {
    const sorted = [...dirs].sort((a, b) => {
      const depthA = a === '/' ? 0 : a.split('/').length - 1;
      const depthB = b === '/' ? 0 : b.split('/').length - 1;
      return depthA - depthB;
    });
    const capped = sorted.slice(0, maxDirectoriesPerEcosystem);
    for (const directory of capped) {
      results.push({ ecosystem, directory });
    }
  }

  return results;
}

export {
  ECOSYSTEM_PATTERNS,
  SKIPPED_SEGMENTS,
  detectEcosystems,
  extractDirectory
};
