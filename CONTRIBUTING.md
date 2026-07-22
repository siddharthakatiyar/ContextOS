# Contributing to ContextOS

First off, thank you for considering contributing to ContextOS! It's people like you that make ContextOS such a great tool.

## Getting Started

1. **Fork & Clone**: Fork the repository and clone your fork locally.
2. **Install Dependencies**: We use npm. Run `npm install` in the project root. (Requires Node.js >=22.12.0, matching `engines` in `package.json`.)
3. **Build**: Run `npm run build` to compile the TypeScript into `dist/` (required for the `contextos` bin). Use `npm run dev` for watch mode during development.

## Development Workflow

- **Run locally**: You can use `npx tsx bin/contextos.ts` for quick local testing without having to run a full build each time.
- **Formatting**: We use Prettier. Before submitting a PR, run `npm run format`.
- **Linting**: We use ESLint. Check for issues using `npm run lint`.
- **Testing**: We use Vitest. Run the test suite with `npm test`.

## Architecture Primer

If you are looking to contribute to the core retrieval engine, you should start by exploring:
- `src/core/retrieval/index.ts`: The entrypoint for the semantic retrieval pipeline.
- `src/core/indexer/`: Code that parses files via AST, chunks them, and stores them in SQLite.
- `src/core/compiler/`: Code that handles token budgeting and creates the final compressed LLM prompt.

For documentation, check out the `docs/` Next.js application.

## Submitting a Pull Request

1. **Create a branch**: `git checkout -b feature/your-feature-name`
2. **Commit your changes**: Write clear, descriptive commit messages.
3. **Write tests**: If you are adding a new feature or fixing a bug, please write a corresponding test in the `tests/` folder.
4. **Push & Open PR**: Push to your fork and open a Pull Request against our `main` branch. Ensure the CI pipeline passes.

## Questions?

Reach out to the maintainer on X [@siddharthakat25](https://x.com/siddharthakat25) or open a discussion if you need help navigating the codebase!
