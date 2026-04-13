# Repository Guidelines

## Project Structure & Module Organization
`src/extension.ts` is the extension entrypoint and wires activation, commands, and views. `src/components/` contains UI-facing providers and panels such as the status bar item, checkpoint tree, and active session tree. `src/checkpoints/` holds the session/checkpoint domain logic, git enrichment, storage, transcript parsing, and search helpers. General utilities live in top-level `src/*.ts` files such as `workspaceProbe.ts` and `runCommand.ts`. Tests live under `src/test/`, with reusable checkpoint fixtures in `src/test/checkpoints/fixtures/`. `media/` stores extension icons. Treat `dist/` and `out/` as generated output.

## Build, Test, and Development Commands
- `pnpm compile`: run type-checking, ESLint, and the esbuild bundle into `dist/extension.js`.
- `pnpm watch`: run esbuild watch mode and `tsc --watch` together for local development.
- `pnpm check-types`: run strict TypeScript checks only.
- `pnpm lint`: lint `src/` with the repository ESLint config.
- `pnpm test`: compile tests, rebuild the extension, and run the VS Code test harness.
- `pnpm package`: build the production bundle used for publishing.

## Coding Style & Naming Conventions
Use strict TypeScript and follow the existing code style: tabs for indentation, semicolons, and mostly single-quoted imports/strings. Use `PascalCase` for classes, providers, and exported types; use `camelCase` for functions and locals; use `UPPER_SNAKE_CASE` for extension-wide constants. Keep command and context identifiers namespaced, for example `session.bridge.entire.refresh`. Let ESLint catch small consistency issues, and do not hand-edit generated files in `dist/` or `out/`.

## Testing Guidelines
Write tests as `*.test.ts` under `src/test/`, mirroring the feature area when possible, such as `src/test/checkpoints/`. This project uses Mocha with `@vscode/test-cli` and `vscode-test`, compiling test files to `out/test/**/*.test.js`. Prefer fixture-backed tests for checkpoint parsing, git metadata joins, and tree/detail view models. No formal coverage threshold is configured, but every behavior change should include or update targeted tests.

## Commit & Pull Request Guidelines
Recent history uses short, imperative commit subjects, sometimes with lightweight prefixes such as `feat:` or `refactor:`. Keep each commit focused on one change and describe behavior, not process. Pull requests should summarize the user-visible effect, list verification commands run, link the relevant issue when applicable, and include screenshots or recordings for tree view, panel, or status bar changes.

## Configuration Notes
This extension targets VS Code `^1.105.0` and assumes an Entire-enabled Git repository at runtime. For tests and local development, prefer checked-in fixtures and mocks over machine-specific `.entire` state or hard-coded paths.
