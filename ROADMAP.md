# ContextOS Roadmap

This document outlines the high-level roadmap and future ambitions for ContextOS following the v1.0 stable release.

## v1.0 (The "Stable" Release) ✅ Released
*Released: July 2026*

ContextOS v1.0.0 is stable and production-ready. All core functionality is covered by the stability policy in `STABILITY.md`.

- [x] **Zero-dependency architecture** (Moved away from Redis/Qdrant to SQLite)
- [x] **Non-blocking Indexing** (Background Daemon handles massive repos seamlessly)
- [x] **Semantic Chunking** (Tree-sitter AST integration)
- [x] **CI/CD & Observability** (Automated linting, formatting, tests, and CLI tracing)
- [x] **Cross-Language AST Completeness** (TSX parser supports JS/JSX/Flow; all major languages parse reliably)
- [x] **Comprehensive Documentation** (Full CLI reference, architecture overview, algorithm docs)

## v1.x (Post-Launch Hardening)

- **Vector Search Optimization**: Refining our local embeddings fallback and evaluating alternative, faster on-device models.
- **Enhanced MCP Tools**: Exposing more granular graph-traversal capabilities to connected LLMs via the Model Context Protocol.
- **Windows Support**: Ensuring native Windows path handling and daemon stability.

## Long-term Vision (v2.0+)

- **Distributed Project Knowledge**: Securely sharing project metadata across developer teams.
- **Predictive Prefetching**: Watching developer cursor movements to preemptively assemble context before an LLM query is even fired.
- **Language Server Protocol (LSP) Integration**: Bringing ContextOS directly into IDE hover states.

*Note: This roadmap is a living document and may change based on community feedback and emerging use cases.*
