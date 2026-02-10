# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Branch protection feature
- Issue/PR templates management
- CODEOWNERS file management
- Web dashboard for monitoring
- Advanced error handling

### Changed
- Improved logging system
- Better error messages
- Enhanced configuration options

### Fixed
- Various bug fixes
- Performance improvements
- Memory leak fixes

## [1.0.0] - 2026-01-24

### Added
- Initial release of Temper
- Automatic repository configuration on creation
- Merge settings management (rebase-only, delete branches)
- Chatops support via `/configure-repo` command
- Issue documentation for configured repositories
- Comprehensive documentation
- Docker support
- Heroku deployment guide
- Development setup guide

### Features
- Real-time GitHub webhook processing
- Probot framework integration
- Octokit API client
- Environment variable configuration
- Error handling and logging
- MIT License

## [0.1.0] - 2026-01-23

### Added
- Initial project setup
- Basic Probot integration
- Repository configuration logic
- Initial documentation

---

## Migration Guide

### From 0.x to 1.0

1. **Update package.json**
   ```bash
   npm install probot@^12.0.0 @octokit/rest@^19.0.0
   ```

2. **Update configuration**
   ```yaml
   # Update config.yml to match new format
   ```

3. **Review changes**
   - New merge settings format
   - Improved error handling
   - Better logging

### From 1.x to 2.0 (Future)

1. **Update dependencies**
   ```bash
   npm install probot@^13.0.0 @octokit/rest@^20.0.0
   ```

2. **Review breaking changes**
   - New configuration format
   - Updated API endpoints
   - New authentication method

## Deprecation Policy

- Features will be deprecated for at least one major version
- Deprecation warnings will be logged
- Migration guides will be provided

## Support Policy

- Latest major version: Full support
- Previous major version: Security fixes only
- Older versions: No support

---

**Note**: This changelog follows semantic versioning (MAJOR.MINOR.PATCH)
