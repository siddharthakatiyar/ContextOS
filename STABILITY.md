# Stability & Versioning Policy

ContextOS follows [Semantic Versioning](https://semver.org/). This document defines what "stable" means for each public surface so you can depend on ContextOS in your daily workflow.

> Summary: from v1.0 onward, breaking changes to any surface below happen only in a **major** version bump, with a deprecation notice first where practical.

## Versioning

- **MAJOR** — backward-incompatible changes to a stable surface below.
- **MINOR** — new, backward-compatible functionality.
- **PATCH** — backward-compatible bug fixes.

From v1.0.0 onward, breaking changes to any stable surface happen only in a **major** version bump (v2.0), with a deprecation notice first where practical. Pre-1.0 (`0.x`) releases changed behavior in minor versions while the engine stabilized.

## Stable surfaces

### 1. CLI
The documented commands are stable: `init`, `reindex`, `serve`, `query`, `status`, `watch`, `visualize`, `clean`, `export`, `import`, `analytics`, `workspace`, `daemon`. Their names, core flags, and documented output will not change incompatibly within a major version.

### 2. MCP interface
The default registered MCP tools (`get_context`, `reindex_context`, `contextos_status`, `ctx_execute`, `ctx_read_file`, `ctx_expand`, `ctx_topics`, `ctx_remember`, `learn_fact`, `forget_fact`, `rate_chunk`, `ctx_symbol`, `get_neighbors`, and `get_symbol`) keep their names and input schemas within a major version. New optional parameters may be added in minor releases. Tools exposed only through `legacyTools` are deprecated compatibility surfaces and are not covered by this guarantee.

### 3. Configuration
Keys defined in [`config.schema.json`](config.schema.json) will not be removed or have their types changed within a major version. The reference defaults live in `src/config/defaults.ts`. Config is read from `.contextos/config.json` (repo) and `~/.contextos/config.json` (global).

### 4. On-disk database
The SQLite index is an **ephemeral, rebuildable** artifact — it is not a stable public interface. Schema migrations are applied automatically, and a corrupted index self-heals by rebuilding. Do not depend on the internal table layout.

## Deprecation policy

When a stable feature must change incompatibly:

1. It is marked deprecated in the release notes / `CHANGELOG.md` and kept working for at least one subsequent minor release where practical.
2. The removal ships in the next major version.

Security fixes may be exempt from the deprecation window when a vulnerability requires an immediate change.

## Reporting

- Bugs / behavior changes: open a GitHub issue.
- Security issues: see [`SECURITY.md`](SECURITY.md).
