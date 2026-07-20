# ContextOS Roadmap

This document outlines the high-level roadmap and future ambitions for ContextOS as we approach v1.0 and beyond. 

## v1.0 (The "Stable" Release)
*Target: Q3 2026*

The goal for v1.0 is to ensure ContextOS is a tool you can depend on daily in your development workflow without worrying about database corruption, hanging daemons, or index desyncs.

- [x] **Zero-dependency architecture** (Moved away from Redis/Qdrant to SQLite)
- [x] **Non-blocking Indexing** (Background Daemon handles massive repos seamlessly)
- [x] **Semantic Chunking** (Tree-sitter AST integration)
- [x] **CI/CD & Observability** (Automated linting, formatting, tests, and CLI tracing)
- [ ] **Cross-Language AST Completeness** (Ensure all major languages parse reliably)
- [ ] **Comprehensive Documentation** (Interactive live examples and full API reference)

## v1.x (Post-Launch Hardening)

- **Vector Search Optimization**: Refining our local embeddings fallback and evaluating alternative, faster on-device models.
- **Enhanced MCP Tools**: Exposing more granluar graph-traversal capabilities to connected LLMs via the Model Context Protocol.
- **Windows Support**: Ensuring native Windows path handling and daemon stability.

## Long-term Vision (v2.0+)

- **Distributed Project Knowledge**: Securely sharing project metadata across developer teams.
- **Predictive Prefetching**: Watching developer cursor movements to preemptively assemble context before an LLM query is even fired.
- **Language Server Protocol (LSP) Integration**: Bringing ContextOS directly into IDE hover states.

*Note: This roadmap is a living document and may change based on community feedback and emerging use cases.*
