module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.js$': ['babel-jest', { configFile: './babel.config.cjs' }]
  },
  transformIgnorePatterns: [
    '/node_modules/(?!probot|@probot|@octokit|before-after-hook|universal-user-agent|octokit-auth-probot)'
  ],
  testMatch: [
    '**/__tests__/unit/**/*.test.js',
    '**/__tests__/integration/**/*.test.js'
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
