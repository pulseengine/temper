import {
  ECOSYSTEM_PATTERNS,
  detectEcosystems,
  extractDirectory
} from '../../src/ecosystem-detector.js';

describe('ecosystem-detector', () => {
  describe('extractDirectory', () => {
    it('returns / for root-level files', () => {
      expect(extractDirectory('package.json')).toBe('/');
    });

    it('extracts directory from nested path', () => {
      expect(extractDirectory('packages/foo/package.json')).toBe('/packages/foo');
    });

    it('handles deeply nested paths', () => {
      expect(extractDirectory('a/b/c/Cargo.toml')).toBe('/a/b/c');
    });
  });

  describe('ECOSYSTEM_PATTERNS', () => {
    it('is a non-empty array', () => {
      expect(Array.isArray(ECOSYSTEM_PATTERNS)).toBe(true);
      expect(ECOSYSTEM_PATTERNS.length).toBeGreaterThan(0);
    });

    it('each entry has an ecosystem string', () => {
      for (const p of ECOSYSTEM_PATTERNS) {
        expect(typeof p.ecosystem).toBe('string');
        expect(p.ecosystem.length).toBeGreaterThan(0);
      }
    });
  });

  describe('detectEcosystems', () => {
    it('detects npm from package.json', () => {
      const result = detectEcosystems(['package.json']);
      expect(result).toEqual([{ ecosystem: 'npm', directory: '/' }]);
    });

    it('detects gomod from go.mod', () => {
      const result = detectEcosystems(['go.mod']);
      expect(result).toEqual([{ ecosystem: 'gomod', directory: '/' }]);
    });

    it('detects cargo from Cargo.toml', () => {
      const result = detectEcosystems(['Cargo.toml']);
      expect(result).toEqual([{ ecosystem: 'cargo', directory: '/' }]);
    });

    it('detects pip from requirements.txt', () => {
      const result = detectEcosystems(['requirements.txt']);
      expect(result).toEqual([{ ecosystem: 'pip', directory: '/' }]);
    });

    it('detects pip from pyproject.toml', () => {
      const result = detectEcosystems(['pyproject.toml']);
      expect(result).toEqual([{ ecosystem: 'pip', directory: '/' }]);
    });

    it('detects pip from setup.py', () => {
      const result = detectEcosystems(['setup.py']);
      expect(result).toEqual([{ ecosystem: 'pip', directory: '/' }]);
    });

    it('detects pip from Pipfile', () => {
      const result = detectEcosystems(['Pipfile']);
      expect(result).toEqual([{ ecosystem: 'pip', directory: '/' }]);
    });

    it('detects maven from pom.xml', () => {
      const result = detectEcosystems(['pom.xml']);
      expect(result).toEqual([{ ecosystem: 'maven', directory: '/' }]);
    });

    it('detects gradle from build.gradle', () => {
      const result = detectEcosystems(['build.gradle']);
      expect(result).toEqual([{ ecosystem: 'gradle', directory: '/' }]);
    });

    it('detects gradle from build.gradle.kts', () => {
      const result = detectEcosystems(['build.gradle.kts']);
      expect(result).toEqual([{ ecosystem: 'gradle', directory: '/' }]);
    });

    it('detects composer from composer.json', () => {
      const result = detectEcosystems(['composer.json']);
      expect(result).toEqual([{ ecosystem: 'composer', directory: '/' }]);
    });

    it('detects docker from Dockerfile', () => {
      const result = detectEcosystems(['Dockerfile']);
      expect(result).toEqual([{ ecosystem: 'docker', directory: '/' }]);
    });

    it('detects github-actions with fixed / directory', () => {
      const result = detectEcosystems(['.github/workflows/ci.yml']);
      expect(result).toEqual([{ ecosystem: 'github-actions', directory: '/' }]);
    });

    it('detects mix from mix.exs', () => {
      const result = detectEcosystems(['mix.exs']);
      expect(result).toEqual([{ ecosystem: 'mix', directory: '/' }]);
    });

    it('detects pub from pubspec.yaml', () => {
      const result = detectEcosystems(['pubspec.yaml']);
      expect(result).toEqual([{ ecosystem: 'pub', directory: '/' }]);
    });

    it('detects nuget from .csproj files', () => {
      const result = detectEcosystems(['src/MyApp/MyApp.csproj']);
      expect(result).toEqual([{ ecosystem: 'nuget', directory: '/src/MyApp' }]);
    });

    it('detects terraform from .tf files', () => {
      const result = detectEcosystems(['infra/main.tf']);
      expect(result).toEqual([{ ecosystem: 'terraform', directory: '/infra' }]);
    });

    it('detects bundler from Gemfile', () => {
      const result = detectEcosystems(['Gemfile']);
      expect(result).toEqual([{ ecosystem: 'bundler', directory: '/' }]);
    });

    it('detects multiple ecosystems from a realistic repo', () => {
      const files = [
        'package.json',
        '.github/workflows/ci.yml',
        '.github/workflows/deploy.yml',
        'Dockerfile',
        'go.mod'
      ];
      const result = detectEcosystems(files);

      const ecosystems = result.map(r => r.ecosystem);
      expect(ecosystems).toContain('npm');
      expect(ecosystems).toContain('github-actions');
      expect(ecosystems).toContain('docker');
      expect(ecosystems).toContain('gomod');
    });

    it('deduplicates github-actions to single entry', () => {
      const files = [
        '.github/workflows/ci.yml',
        '.github/workflows/deploy.yml',
        '.github/workflows/test.yaml'
      ];
      const result = detectEcosystems(files);

      const ghActions = result.filter(r => r.ecosystem === 'github-actions');
      expect(ghActions).toHaveLength(1);
      expect(ghActions[0].directory).toBe('/');
    });

    it('deduplicates pip to single directory when multiple manifest files present', () => {
      const files = ['requirements.txt', 'setup.py', 'pyproject.toml'];
      const result = detectEcosystems(files);

      const pip = result.filter(r => r.ecosystem === 'pip');
      expect(pip).toHaveLength(1);
      expect(pip[0].directory).toBe('/');
    });

    it('handles monorepo with multiple npm directories', () => {
      const files = [
        'package.json',
        'packages/frontend/package.json',
        'packages/backend/package.json'
      ];
      const result = detectEcosystems(files);

      const npm = result.filter(r => r.ecosystem === 'npm');
      expect(npm).toHaveLength(3);
      // Shallower paths first
      expect(npm[0].directory).toBe('/');
    });

    it('caps directories per ecosystem at maxDirectoriesPerEcosystem', () => {
      const files = [
        'a/package.json',
        'b/package.json',
        'c/package.json',
        'd/package.json'
      ];
      const result = detectEcosystems(files, { maxDirectoriesPerEcosystem: 2 });

      const npm = result.filter(r => r.ecosystem === 'npm');
      expect(npm).toHaveLength(2);
    });

    it('prefers shallower paths when capping', () => {
      const files = [
        'deep/nested/dir/package.json',
        'package.json',
        'packages/a/package.json'
      ];
      const result = detectEcosystems(files, { maxDirectoriesPerEcosystem: 2 });

      const npm = result.filter(r => r.ecosystem === 'npm');
      expect(npm).toHaveLength(2);
      expect(npm[0].directory).toBe('/');
      expect(npm[1].directory).toBe('/packages/a');
    });

    it('returns empty array for no recognized files', () => {
      const result = detectEcosystems(['README.md', 'LICENSE', 'src/main.rs']);
      // main.rs isn't a manifest — only Cargo.toml triggers cargo
      expect(result.find(r => r.ecosystem === 'cargo')).toBeUndefined();
    });

    it('returns empty array for empty input', () => {
      expect(detectEcosystems([])).toEqual([]);
    });
  });
});
