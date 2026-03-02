module.exports = {
  testEnvironment: 'node',
  resolver: './jest-resolver.cjs',
  transform: {
    '^.+\\.js$': ['babel-jest', { configFile: './babel.config.cjs' }]
  },
  transformIgnorePatterns: [
    '/node_modules/(?!probot|@probot|@octokit|before-after-hook|universal-user-agent|universal-github-app-jwt|octokit-auth-probot)'
  ],
  testMatch: [
    '**/__tests__/unit/**/*.test.js',
    '**/__tests__/integration/**/*.test.js',
    '**/__tests__/smoke/**/*.test.js',
    '**/__tests__/e2e/**/*.test.js'
  ],
  collectCoverageFrom: [
    'src/**/*.js',
    'index.js',
    '!**/node_modules/**'
  ],
  coverageThreshold: {
    global: {
      lines: 80,
      functions: 80,
      branches: 70
    }
  }
};
