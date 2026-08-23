# Changelog

![AI Agent using ContextOS semantic search](docs/public/query-where.gif)

All notable changes to ContextOS are documented here.

This project follows Semantic Versioning and Keep a Changelog.

---

## [1.0.1] - 2026-08-15

### Fixed

- **Docs**: Stabilized hero terminal scrolling on the documentation site (#29).

### Changed

- Security dependency bumps for the `npm_and_yarn` group across the root and docs workspaces (#30).

---

## [1.0.0] - 2026-08-04

First stable release of ContextOS.

See the full [release notes](./v1.0.0-release-notes.md) for highlights.

### Added

- **v1.0.0 Stable**: ContextOS is now production-ready. Documented CLI commands, default MCP tools, and configuration keys are covered by the stability policy in `STABILITY.md`. The rebuildable SQLite index remains an internal implementation detail.

---

## [0.9.5] - 2026-07-27

### Changed

- Release version bump to `v0.9.5`.

---

## [0.9.4] - 2026-07-26

### Added

- **Token Clamping & Optimizations**: Implemented stub tier optimizations and strict token clamping to ensure bounded context windows.
- **Auto-Reindexing**: The daemon now automatically detects structural schema/indexer changes (via `INDEXER_VERSION`) and gracefully triggers a background repo re-index on update without requiring manual user intervention.
- **Trigram FTS**: Migrated to database schema v6 with FTS5 trigram indices for extremely fast and accurate substring searches.

---

## [0.9.3] - 2026-07-25

### Fixed

- **Parser Engine**: Fixed a critical bug where `.js` and `.jsx` files containing Flow type annotations (such as the React repository) would cause Tree-sitter AST syntax errors, resulting in the symbol extractor silently missing functions and variables. ContextOS now correctly utilizes the robust `tsx` parser for these extensions, fully supporting modern Flow and JSX syntax.

---

## [0.9.2] - 2026-07-23

> **AI agents now retrieve semantic context before wandering through your repository.**

This release significantly improves the experience of using ContextOS with MCP-compatible AI Agents. It also makes large repository indexing substantially more resilient during massive filesystem changes.

### 🚀 Highlights

- AI Agents now automatically receive semantic retrieval instructions during `contextos init`, ensuring they prioritize `get_context` before falling back to expensive file exploration.
- Massive filesystem events (such as `git checkout`, `git switch`, or `npm install`) are now intelligently coalesced into a single background re-index instead of triggering thousands of individual updates.
- Better defaults for AI coding workflows with no additional configuration.

---

### Added

#### Native Agent Guidance

ContextOS now configures supported AI coding agents to prefer semantic retrieval before broad repository searches.

Supported today:

- Any AI Agent (via automatic configuration generation)
- MCP clients supporting the official `instructions` field

This dramatically reduces unnecessary exploration while improving retrieval accuracy.

---

#### Watcher Burst Detection

Large filesystem bursts are now detected automatically.

Instead of processing thousands of individual file events, ContextOS now:

- detects filesystem floods
- pauses incremental indexing
- performs a single optimized repository sweep

Common examples include:

- `git checkout`
- `git switch`
- `git rebase`
- `npm install`
- dependency updates

This keeps indexing responsive even on very large repositories.

---

### Changed

- Improved initialization experience for AI Agents.
- Better indexing behaviour during large repository updates.

---

### Fixed

- AI Agents now automatically receive retrieval guidance even if they ignore the MCP SDK `instructions` field.

---

## Upgrade

Simply run

```bash
npm update -g @siddharthakatiyar/contextos 
```

## [0.9.0] - 2026-07-22

Security hardening and robust large repository support for the upcoming v1.0 release.

### Added
- **Path Traversal Guards**: Added explicit sandbox boundaries so the indexer refuses to parse `../../` files beyond workspace roots.
- **Malicious Repo Protection**: Implemented a hard cap (1,000,000 files) on glob limits to prevent Out-Of-Memory (OOM) crashes on massive directories (like `~/`).
- **DOS Protection**: Throttled concurrent file watcher events with an asynchronous queue (`pLimit`), preventing daemon crashes from CPU starvation during huge `git checkout` branch swaps.
- **`execAllowRepoScripts` opt-out**: New config flag (and `CONTEXTOS_EXEC_ALLOW_SCRIPTS` env) to disable `ctx_execute` running a repository's own npm/npx scripts on untrusted repos. Default remains enabled.
- **`STABILITY.md`**: Documented the SemVer / deprecation / public-surface stability policy.
- **CI**: macOS runners added to the test matrix; the publish workflow now verifies the pushed tag matches `package.json`.

### Changed
- Clarified `contextos serve` behavior in documentation, explaining it is managed by MCP clients and should not be run manually.
- **Retrieval default**: `pipeline.embeddingFusion` now follows `embeddingsRetrieval` (off by default; confidence-gated) instead of being forced on — queries no longer run embedding-kNN fusion unless you opt in. See UPGRADING.
- **Benchmark**: the suite now measures ContextOS only (competitor comparison arms removed).
- **Storage**: prepared statements are cached per connection and extra SQLite PRAGMAs (`synchronous=NORMAL`, cache/mmap/temp_store) are applied for faster indexing.

### Fixed
- **`ctx_expand`** now validates file paths against the workspace root (previously an unguarded arbitrary file read).
- **Workspace boundary** checks in `ctx_read_file` / `reindex_context` / `ctx_execute` resolve symlinks (realpath) and reject a bare `..` argument.
- **Dependencies**: bumped `brace-expansion` (ReDoS) and `esbuild` via `npm audit fix`.
- **Parser**: tree-sitter is no longer a shared mutable singleton (fixes a wrong-grammar race under concurrent indexing).
- **Docs**: corrected the license (MIT), config defaults, MCP tool list, and the JSON config schema.

## [0.8.0] - 2026-07-20

Zero-dependency local SQLite architecture and non-blocking background daemon indexing.

### Added
- **Background Daemon Indexing**: ContextOS now spawns a non-blocking daemon on `contextos init`. Massive repositories (50,000+ files) are now indexed seamlessly in the background without blocking your CLI or editor.
- **Local SQLite Architecture**: Migrated fully away from Redis & Qdrant to a zero-dependency local SQLite architecture using FTS5 (BM25 ranking) and recursive Graph BFS (relationship expansion).
- **Retrieval Benchmarks**: Added 6 new framework-specific retrieval benchmarks (`nextjs-rsc-boundaries`, `express-auth-routing`, etc.) which achieved 100% recall.
- **Hybrid Embedding Fusion**: Optionally injects embeddings when keyword confidence is low (enabled via `embeddingsRetrieval: true`).
- **Update Notifier**: The CLI now notifies you in the background when a new release is available on npm.

### Changed
- `contextos init` now returns instantly while indexing continues in the background. Check progress via `contextos status`.
- MCP tools no longer require a running daemon/server to execute local retrieval requests.

### Removed
- Removed Redis caching and Qdrant vector database requirements. ContextOS is now 100% zero-dependency.

## [0.7.1] - 2026-07-19

Documentation updates and stability improvements for graph expansion.

### Added
- Comprehensive Next.js Documentation site at `/docs`.
- New `contextos status --json` output for IDE plugins and CI tracking.
- Interactive terminal metrics and visualization for Graph Expansion limits.

### Fixed
- Fixed cyclical import detection during AST chunking which caused infinite loops in specific Monorepo setups.

## [0.7.0] - 2026-07-16

The largest architectural rewrite since ContextOS was created.

### Changed
- **Breaking Change**: Consolidated MCP tools. `ctx_search`, `ctx_graph`, and `ctx_ast` were merged into a single unified `ctx_retrieve` tool for simplicity.
- Revamped token budget enforcing. ContextOS now physically counts tokens using `gpt-tokenizer` to ensure strictly bound Context Windows.

## [0.6.0] - 2026-07-10

Retrieval overhaul featuring Schema v5, RRF fusion, and local embeddings.

### Changed
- **RRF Fusion Retrieval**: Combined ranking signals using Reciprocal Rank Fusion.
- **Query-Aware Compile**: Compilation now adapts to the query intent.
- **Hardened MCP Tools**: Improved robustness of MCP tool execution.

## [0.5.0] - 2026-07-10

Major token optimization cutting E2E tokens under baseline.

### Changed
- **Tiered Compile**: Introduced a tiered compilation strategy to reduce token usage.
- **Retrieval Precision**: Improved precision of retrieved context.

## [0.4.0] - 2026-07-07

General robustness and security update.

### Changed
- **Security Patches**: Addressed known security issues.
- **Stability Improvements**: General reliability fixes across the CLI.

## [0.3.0] - 2026-07-06

Introduced cross-session memory and smart context assembly.

### Added
- **Cross-Session Memory**: Context now persists across sessions.
- **Smart Context Assembly**: Automatically assembles relevant context for a query.
- **Graph Visualization**: Visualize the relationship graph between files.

## [0.2.0] - 2026-06-09

First public beta of ContextOS.

### Added
- **Basic File Retrieval**: Initial retrieval implementation.
- **CLI Interface**: First version of the command-line interface.
