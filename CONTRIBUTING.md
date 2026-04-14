# Contributing to Session Bridge

Thank you for your interest in contributing to Session Bridge! This guide will help you get started with the project and understand our development process.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (latest LTS recommended)
- [pnpm](https://pnpm.io/) for package management
- [VS Code](https://code.visualstudio.com/) for development
- [Entire CLI](https://github.com/entireio/cli) (v0.5.5 or newer) installed on your system

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/savekirk/session-bridge.git
   cd session-bridge
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

## Development Workflow

### Build Commands

We use `pnpm` for all development tasks. Key scripts include:

- `pnpm compile`: Performs type-checking, linting, and bundles the extension into `dist/extension.js`.
- `pnpm watch`: Runs esbuild and TypeScript in watch mode for local development.
- `pnpm check-types`: Runs strict TypeScript checks only.
- `pnpm lint`: Lints the `src/` directory using our ESLint configuration.
- `pnpm package`: Builds the production bundle used for publishing.

### Running the Extension Locally

1. Open the project in VS Code.
2. Press `F5` or go to the "Run and Debug" view and select "Run Extension".
3. A new VS Code window (Extension Development Host) will open with the extension loaded.

## Project Structure

- `src/extension.ts`: Extension entry point, command registration, and view wiring.
- `src/components/`: UI-facing providers and panels (Status Bar, Tree Views, Panels).
- `src/checkpoints/`: Core domain logic for sessions, checkpoints, Git enrichment, and storage.
- `src/test/`: Test suites, mirrored to the source structure.
- `media/`: Extension icons and demo assets.
- `dist/` and `out/`: Generated build and test outputs (ignored by Git).

## Coding Standards

We follow strict TypeScript and specific formatting conventions:

- **Indentation**: Use **tabs** for indentation.
- **Quotes**: Use **single quotes** for imports and strings unless escaping is necessary.
- **Semicolons**: Always use semicolons.
- **Naming Conventions**:
  - `PascalCase` for classes, providers, and exported types.
  - `camelCase` for functions and local variables.
  - `UPPER_SNAKE_CASE` for extension-wide constants.
- **Namespacing**: Commands and context identifiers should be namespaced (e.g., `session.bridge.entire.refresh`).

## Testing Guidelines

Every bug fix or new feature should include or update targeted tests.

- **Location**: Write tests as `*.test.ts` under `src/test/`, mirroring the `src/` structure.
- **Framework**: We use Mocha with `@vscode/test-cli`.
- **Running Tests**: Run `pnpm test` to compile tests, rebuild the extension, and execute the VS Code test harness.
- **Fixtures**: Prefer fixture-backed tests for complex logic like checkpoint parsing or Git metadata joins. Existing fixtures are located in `src/test/checkpoints/fixtures/`.

## Commit and Pull Request Guidelines

### Commit Messages

- Use short, imperative subjects (e.g., `feat: add session search`).
- Use lightweight prefixes like `feat:`, `fix:`, `refactor:`, or `docs:`.
- Focus on the **why** of the change rather than the process.

### Pull Requests

**Important**: Before starting work on any significant change or submitting a pull request, please open a [discussion](https://github.com/savekirk/session-bridge/discussions) or an [issue](https://github.com/savekirk/session-bridge/issues) to discuss your proposal. This helps ensure your contribution aligns with the project's direction and avoids wasted effort.

- Summarize the user-visible effect of the change.
- List the verification steps or commands run.
- Link relevant issues if applicable.
- **UI Changes**: Include screenshots or recordings if the PR modifies tree views, panels, or the status bar.

## Reporting Issues

Use the [GitHub Issues](https://github.com/savekirk/session-bridge/issues) page to report bugs or suggest features. When reporting a bug, please include:
- A clear description of the issue.
- Steps to reproduce.
- Your OS and VS Code version.
- Entire CLI version.
