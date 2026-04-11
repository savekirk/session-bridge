# Change Log

All notable changes to the "session-bridge" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- Initial release
- Reused checkpoint summary `sessionPaths` when loading sessions for a selected checkpoint, falling back to checkpoint-id lookup only when those paths are unavailable.
- Removed the active-sessions tree surface from the Sessions view so it now shows only sessions for the selected checkpoint.
