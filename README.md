# Session Bridge

> This is an **unofficial** VS Code extension. It is not developed by, endorsed by, or in any way related to the [Entire](https://entire.io) team.

Session Bridge is an unofficial VS Code extension for browsing [Entire](https://entire.io) checkpoints and the committed sessions captured in those checkpoints from the current repository.

## Requirements
- Visual Studio Code `1.10` or newer (or editors compatible with VS Code `1.10+` APIs)
- [Entire CLI](github.com/entireio/cli) version `0.5.5` or newer

## Using the extension
Session Bridge works with any git repository that has [Entire](https://docs.entire.io/introduction) configured to capture your AI agent sessions. You don't need to be logged in to your [Entire](https://entire.io) account to view your sessions. 

Open any Entire managed git repository and the `Session Bridge (Entire)` status bar will show at the bottom. 

Select or open the installed Session Bridge extension to view your checkpoints.

## Features

- **Browse your committed checkpoints.**
  <p align="center">
  <img src="docs/assets/checkpoints.gif" width=75%>
  <br/>
  <em>(Browse Checkpoints)</em>
  </p>

- **View diffs of changes within a checkpoint.**
  <p align="center">
  <img src="docs/assets/view-diffs.gif" width=75%>
  <br/>
  <em>(View Diffs)</em>
  </p>

- **View sessions within a selected checkpoint.**
  <p align="center">
  <img src="docs/assets/sessions.gif" width=75%>
  <br/>
  <em>(List Sessions)</em>
  </p>

- **View details of a session.**
  <p align="center">
  <img src="docs/assets/session-details.gif" width=75%>
  <br/>
  <em>(Session Details)</em>
  </p>

- **View status of active sessions.**
  <p align="center">
  <img src="docs/assets/active-sessions.gif" width=75%>
  <br/>
  <em>(Active Sessions Status)</em>
  </p>

- **Run [Entire CLI](github.com/entireio/cli) commands**

## Known Issues

 - Some of the transcript might not be properly parsed.

## Release Notes

### 0.0.1

Initial release

## Contributing

Contributions are welcome! Please see our [Contribution Guide](CONTRIBUTING.md) for details on how to get started, coding standards, and our development workflow.