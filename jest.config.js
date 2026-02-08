module.exports = {
  testEnvironment: 'node',
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
