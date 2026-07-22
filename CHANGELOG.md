# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
