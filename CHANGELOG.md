# Change Log

All notable changes to the "session-bridge" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).


## [Unreleased]

## [0.0.2] - 2026-04-14

### Fixed
- Fixed missing extension icon in the VS Code Marketplace by adding the top-level `icon` field to `package.json`.
- Converted all extension icons from SVG to PNG format to ensure compatibility with the VS Code Marketplace.

### Changed
- Replaced themed SVGs with PNG versions for the marketplace icon, activity bar, and tree view icons.
- Removed original SVG icon files from the repository.

## [0.0.1] - 2026-04-14

- Initial release of Session Bridge for Entire.
- Added support for browsing committed checkpoints in the active Git repository.
- Added functionality to view diffs of changes within a specific checkpoint.
- Added a dedicated view for sessions captured within a selected checkpoint.
- Implemented session details panel for inspecting session transcripts and metadata.
- Integrated Entire status bar item to show active sessions and quick actions.
- Added commands to run Entire CLI operations (Enable, Disable, Refresh, Clean, etc.).
- Improved performance by reusing `sessionPaths` from checkpoint summaries when loading sessions.
- Simplified the Sessions view to focus exclusively on sessions from the selected checkpoint.
