# Upgrading ContextOS

## 1.2.2 patch

No action is required. Adding a project to a group no longer rewrites client configuration or agent-instruction files in other registered projects, and generated files are hidden through `.git/info/exclude`. To register a project without any integration files, use `contextos init --no-integrations`. Views with a few unindexable files now stay ready with a warning; retry them with `contextos reindex --failed`. `contextos daemon start --detach` runs the daemon in the background. `--group` is now the primary selector and `--workspace` remains an alias.

## 1.2.1 patch

Global instruction setup is now explicit. A default global npm installation leaves user-wide coding-agent instruction files unchanged, including managed blocks from an earlier installation. To preview and apply changes yourself:

```bash
contextos enable --dry-run --json
contextos enable
# Or select one installed client:
contextos enable --agent claude
```

Project setup remains separate. `contextos init` configures a selected project. By default, a global npm install also refreshes **known existing projects**: it can stop verified older daemons, copy legacy indexes into global storage, and update project instructions/MCP configuration. It does not discover or initialize arbitrary new projects. Use `CONTEXTOS_SKIP_SETUP=1` to skip this automatic migration. Local npm installation does not run that project migration hook.

### The two controls in released 1.2.0

Version **1.2.0** automatically writes global instructions unless `CONTEXTOS_GLOBAL_INSTRUCTIONS=0` is set. That variable does **not** disable project migration, daemon shutdown, or project instruction updates. For 1.2.0, use both controls to suppress both install-time hooks:

```bash
CONTEXTOS_GLOBAL_INSTRUCTIONS=0 CONTEXTOS_SKIP_SETUP=1 npm install -g @siddharthakatiyar/contextos@1.2.0
```

PowerShell equivalent:

```powershell
$env:CONTEXTOS_GLOBAL_INSTRUCTIONS = "0"
$env:CONTEXTOS_SKIP_SETUP = "1"
npm install -g @siddharthakatiyar/contextos@1.2.0
```

In **1.2.1**, `CONTEXTOS_GLOBAL_INSTRUCTIONS` no longer enables an installation hook; global instructions change only through `contextos enable`. `CONTEXTOS_SKIP_SETUP=1` still controls automatic existing-project migration.

An environment setting applied only to `npm install` does not apply to later CLI sessions. First use of `query`, `serve`, `watch`, `reindex`, `status`, or `init` can still perform existing-project migration. Keep `CONTEXTOS_SKIP_SETUP=1` in that session if you want migration to remain deferred. When ready, remove that setting and run `contextos setup --upgrade --no-index --json`; omit `--no-index` to index immediately. Staged self-upgrades suppress both install-time hooks until the package swap completes.

### Removing global instructions installed by earlier versions

Run `contextos enable --dry-run --json` to find the effective supported instruction paths without changing them. Inspect these common locations; configured agent home directories can override them:

| Client                   | User-wide instruction file                               |
| ------------------------ | -------------------------------------------------------- |
| Codex                    | `~/.codex/AGENTS.md`                                     |
| Claude Code              | `~/.claude/AGENTS.md`, imported by `~/.claude/CLAUDE.md` |
| Grok Build               | `~/.grok/AGENTS.md`                                      |
| OpenCode                 | `~/.config/opencode/AGENTS.md`                           |
| Gemini CLI / Antigravity | `~/.gemini/GEMINI.md`                                    |
| Amp                      | `~/.config/amp/AGENTS.md`                                |
| Copilot CLI              | `~/.copilot/copilot-instructions.md`                     |
| Windsurf                 | `~/.codeium/windsurf/memories/global_rules.md`           |

Back up the file, then remove only the section between the following markers, including the markers. Keep all user-written text outside that section:

```text
<!-- contextos:managed:start -->
...ContextOS managed instructions...
<!-- contextos:managed:end -->
```

Do not delete an entire instruction file that also contains your own guidance. In Claude's global `CLAUDE.md`, keep `@AGENTS.md` if the imported file still contains useful instructions. Remove the import only if you have removed the now-empty imported file and confirmed the import was added for ContextOS. Cursor's optional instructions live in its manual User Rules settings and must be removed there. Removing these instruction blocks does not delete indexes, memories, projects, or MCP registrations.

## Direct upgrades from 1.0.x and older project storage

Before upgrading an important project, stop its old daemon explicitly and back up both `~/.contextos/` and the project's `.contextos/` folder. Version 1.0.x does not support authenticated upgrade control: automatic setup refuses to signal that daemon and leaves saved data available for recovery. Stop it using that release's command in each project:

```bash
cd ~/projects/backend
contextos daemon stop
contextos daemon status
```

Check that the old process has actually exited before migration. The tested 1.0.3 daemon can close its database and remove its PID file while a 30-minute cleanup timer keeps the process alive; its stop command may keep waiting. Record the daemon PID before stopping it and check that process in your operating system's process manager. If it remains, stop that specific old ContextOS process manually after its database has closed. The new installer never force-kills it. The direct-upgrade recovery test terminates only its own isolated fixture process to cover this case.

After installing the new package, retry setup with `contextos setup --upgrade --no-index --json`. A reported failure is not permission to delete an index: repair the reported issue (for example, invalid project MCP JSON), then retry the same command. Legacy indexes remain in their original directories. An unavailable project remains registered for later recovery.

Migration copies the local SQLite index into the corresponding global project/worktree view, preserving saved knowledge and history. Legacy workspace registrations are imported when present. New data is stored under `~/.contextos/`; each checked-out worktree/branch view has a separate index. New retrieval can rebuild parsed content while retaining memories and history. The original local database and any backups remain available; never restore over a database while a daemon is using it.

Existing group memberships and explicit MCP commands are preserved. Reconnect your coding agent after setup. A custom MCP entry pinned to an older executable/version needs updating separately. Automatic process verification currently supports Linux and macOS; other platforms require stopping older daemons manually.

New projects still use `contextos init`. A project can join multiple groups without duplicating its index. Use `contextos clean --dry-run` to inspect obsolete worktree/branch data before cleanup. `contextos project remove <project> --purge` deletes stored project data while retaining source files; it is unrelated to removing global instructions.

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
