# Upgrading ContextOS

This guide covers breaking changes and migration steps for upgrading ContextOS across major and minor versions.

## 1.1.0 to 1.1.1 (local testing candidate)

Version 1.1.1 changes new storage from a database inside each repository to a global project registry and separate indexes for checked-out worktrees and branch views. The candidate is not published; do not install it from npm. Build it from a source checkout using [the local testing guide](MULTI_REPOSITORY_TESTING.md).

Before trying the candidate with important saved data, stop older ContextOS daemons and make a backup of both `~/.contextos/` and any repository `.contextos` directories. On first registration, ContextOS discovers the project's currently checked-out Git worktrees and copies an existing local SQLite index into its corresponding global view. The original repository files are retained as migration sources. ContextOS leaves the old files in place; new indexes, facts, and runtime files are written under `~/.contextos/`. Legacy workspace registration is imported into `~/.contextos/registry.db` when found.

Initialize one project or create a group and initialize into it:

```bash
cd ~/projects/backend
contextos init

contextos group create payments
contextos init --group payments
contextos group add payments ~/projects/frontend
contextos group add payments ~/projects/shared-types
```

Existing single-project commands continue to find the active registered checkout. `contextos repo` remains an alias for `contextos project`, and `--workspace` / `--all-repos` remain accepted as compatibility selectors for groups. New queries still use the active checkout by default; use `--group payments` to search a group. A group query selects one available checkout per project unless `--all-worktrees` is requested.

Initialization now puts shared agent instructions in `AGENTS.md` and adds an `@AGENTS.md` import to `CLAUDE.md` when needed. Re-run `contextos init` to migrate recognizable generated ContextOS sections from older `CLAUDE.md` files. User-authored guidance in both files is preserved, and repeated initialization does not duplicate the instructions or import.

Each project can belong to multiple groups without duplicating its index. Every checked-out worktree has a distinct view; a branch switch is reconciled before its new view is used. ContextOS does not create, switch, or remove Git worktrees. Use `contextos clean --dry-run` to inspect stored views for removed worktrees or deleted branches, then `contextos clean` to remove stale data. `contextos project remove <project> --purge` explicitly deletes all stored data for a project while retaining source files.

The old release's published/runtime behavior should not be confused with this candidate. Publishing remains pending until local testing is complete and the user explicitly approves release.

## 0.9.x to 1.0.0

### 1. Automatic schema migration (no action required)

v1.0.0 ships Schema v6, which adds FTS5 trigram indices for extremely fast and accurate substring searches. The daemon detects the schema version automatically on startup via `INDEXER_VERSION` and triggers a background re-index. No manual steps are required.

### 2. SemVer stability guarantees now apply

From v1.0.0 onward, all stable CLI commands, MCP tools, and configuration keys are covered by the full SemVer stability policy described in [`STABILITY.md`](STABILITY.md). Breaking changes will only appear in a future v2.0 major release, with a deprecation notice first.

### 3. Reindex recommendation

After upgrading, run `contextos reindex` once to ensure the trigram FTS tables are fully populated and retrieval performance is optimal.

---

## 0.8.x to 0.9.x


### 1. Reindex after upgrading
Run `contextos reindex` once after upgrading so schema/chunking refinements take effect.

### 2. Embedding fusion is off by default
`pipeline.embeddingFusion` now follows `embeddingsRetrieval` (off by default) instead of being unintentionally forced on. Retrieval uses the keyword/RRF path as the baseline, with embeddings as a confidence-gated fallback. To keep fusion always on, set it explicitly:
```json
{ "pipeline": { "embeddingFusion": true } }
```

### 3. ctx_execute repository scripts are opt-in
Current releases leave `ctx_execute` repository scripts disabled by default. To run a repository's own `npm`/`npx` scripts, set `execAllowRepoScripts: true` or `CONTEXTOS_EXEC_ALLOW_SCRIPTS=1` only for a trusted repository. `CONTEXTOS_EXEC_ALLOW_SCRIPTS=0` explicitly keeps them disabled.

## 0.7.x to 0.8.x

The `0.8.0` release introduces a massive architectural shift to a zero-dependency local SQLite architecture. 

### 1. Redis and Qdrant are no longer required
If you previously had `docker-compose` files or local instances of Redis and Qdrant running to support ContextOS, you can safely shut them down. ContextOS now uses `better-sqlite3` and `sqlite-vec` internally.

### 2. Initialization is now non-blocking
When you run `contextos init`, the CLI will now return instantly. A background daemon is spawned to index the repository. 
- You can check progress via `contextos status`.
- You can immediately start using `contextos query`, though results will be limited until the index completes.

### 3. Configuration Changes
The `contextos.json` schema has been updated. The `redis_url` and `qdrant_url` fields are deprecated and ignored. 

If you want to enable the new Hybrid Embedding Fusion (which uses the Xenova local embedding model), add the following to your `contextos.json`:
```json
{
  "pipeline": {
    "embeddingFusion": true
  }
}
```

## 0.6.x to 0.7.x

### 1. MCP Tool Consolidation
The `ctx_search`, `ctx_graph`, and `ctx_ast` tools have been removed. They are replaced by a single, unified `ctx_retrieve` tool. Update your AI Assistant prompts to call `ctx_retrieve` instead.

### 2. Token Budgets
The `max_results` configuration has been deprecated in favor of `maxTokenBudget`. ContextOS now measures actual LLM tokens instead of arbitrary chunk counts.
