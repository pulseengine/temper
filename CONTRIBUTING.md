# Contributing to Temper

**Thank you for your interest in contributing!**

This guide will help you get started with contributing to the Temper project.

## Code of Conduct

By participating in this project, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).

## Getting Started

### Prerequisites

- Node.js >= 20.11.0
- npm or yarn
- Git
- GitHub account

### Setup

```bash
# Fork the repository
git clone https://github.com/your-username/temper.git
cd temper

# Install dependencies
npm install

# Set up environment
cp .env.example .env
# Edit .env with your GitHub App credentials
```

## How to Contribute

### Reporting Bugs

1. **Check existing issues** - Search to see if the bug has already been reported
2. **Create a new issue** - Use the bug report template
3. **Provide details**:
   - Steps to reproduce
   - Expected behavior
   - Actual behavior
   - Screenshots (if applicable)
   - Environment details

### Suggesting Features

1. **Check existing issues** - Search to see if the feature has been requested
2. **Create a new issue** - Use the feature request template
3. **Provide details**:
   - Use case description
   - Example scenarios
   - Potential implementation ideas

### Submitting Pull Requests

1. **Fork the repository**
2. **Create a feature branch**:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes**
4. **Write tests** (if applicable)
5. **Update documentation**
6. **Commit your changes**:
   ```bash
   git commit -m "feat: add your feature description"
   ```
7. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```
8. **Open a pull request**

## Development Guidelines

### Code Style

- **Indentation**: 2 spaces (no tabs)
- **Line length**: 80-100 characters
- **Naming**: camelCase for variables, PascalCase for classes
- **Comments**: Use JSDoc for functions
- **Error handling**: Always handle errors gracefully

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add new feature
fix: fix a bug
docs: update documentation
style: formatting changes
refactor: code refactoring
perf: performance improvements
test: add tests
chore: maintenance tasks
```

### Branch Naming

```
feature/your-feature
fix/your-bug-fix
docs/your-docs-update
refactor/your-refactoring
```

## Testing

### Manual Testing

```bash
# Create a test repository
gh repo create pulseengine/test-repo --private

# Verify configuration
gh api repos/pulseengine/test-repo --jq '.allow_merge_commit, .allow_squash_merge, .allow_rebase_merge, .delete_branch_on_merge'

# Clean up
gh repo delete pulseengine/test-repo --confirm
```

### Running Tests

`npm test` runs 453 tests. See DEVELOPMENT.md for test structure details.

## Documentation

### Updating Documentation

- Keep README.md up to date
- Update relevant guides
- Add examples where helpful
- Use clear, concise language

### Documentation Style

- Use Markdown formatting
- Keep sentences short
- Use bullet points for lists
- Add code examples
- Include screenshots where helpful

## Feature Development

### Adding New Features

1. **Open an issue** - Discuss the feature first
2. **Get approval** - Wait for maintainer feedback
3. **Implement** - Write the code
4. **Test** - Verify it works
5. **Document** - Update documentation
6. **Submit PR** - Open a pull request

### Feature Checklist

- [ ] Code implemented
- [ ] Tests added (if applicable)
- [ ] Documentation updated
- [ ] Examples provided
- [ ] Error handling included
- [ ] Performance considered

## Release Process

### Versioning

We use [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

### Release Steps

1. **Update CHANGELOG.md**
2. **Update version in package.json**
3. **Create GitHub release**
4. **Publish to npm** (if applicable)
5. **Announce release**

## Maintainer Guidelines

### Reviewing Pull Requests

1. **Check for tests** - Are tests included?
2. **Review code quality** - Does it follow guidelines?
3. **Test the changes** - Does it work as expected?
4. **Check documentation** - Is it updated?
5. **Provide feedback** - Be constructive and helpful

### Merging Pull Requests

1. **Wait for CI** - All checks must pass
2. **Get approvals** - At least one maintainer approval
3. **Squash and merge** - Keep history clean
4. **Delete branch** - After merging
5. **Thank contributor** - Show appreciation

## Recognition

Contributors will be recognized in:

- CHANGELOG.md
- CONTRIBUTORS.md
- GitHub contributors list
- Release notes

## Resources

- [Probot Documentation](https://probot.github.io/docs/)
- [GitHub API Documentation](https://docs.github.com/en/rest)
- [Octokit Documentation](https://octokit.github.io/rest.js/)
- [Conventional Commits](https://www.conventionalcommits.org/)
- [Semantic Versioning](https://semver.org/)
