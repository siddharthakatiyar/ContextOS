# ContextOS 1.1.1 local testing

This guide covers testing ContextOS 1.1.1 across several local repositories, including one workspace MCP server.

## Build and automated checks

Use Node 22.12 or newer and the repository's installed dependencies:

```bash
npm run build
npm run lint
npm run format:check
npm test
npm run bench
node dist/bin/contextos.js --version
```

The version must be `1.1.1`. Install the published package with `npm install -g @siddharthakatiyar/contextos@1.1.1`, or use `node /absolute/path/to/ContextOS/dist/bin/contextos.js` in place of `contextos` below to test a source checkout.

The automated workspace fixtures include four repositories, duplicate symbol names, matching content hashes/local chunk IDs, independent edits and deletions, migration from schema v6, hybrid retrieval routing, ownership delegation, and two MCP clients sharing one workspace daemon. Embedding routing tests use deterministic mocked model results; the relevance/performance baseline disables embeddings. Also exercise your installed local model manually if you normally use it.

## Register real repositories

```bash
contextos repo add ~/projects/backend
contextos repo add ~/projects/frontend
contextos repo add ~/projects/shared-types
contextos repo add ~/projects/infrastructure
contextos repo list --json
contextos repo status --workspace default --json
```

Each add waits for indexing. Confirm distinct persistent IDs, correct canonical paths, `ready` status, and plausible counts. Repeat an add and verify it reuses the ID. For duplicate directory names use `--name backend-other`.

For another workspace:

```bash
contextos workspace add payments
contextos repo add ~/projects/backend --workspace payments
contextos repo add ~/projects/frontend --workspace payments
contextos repo add ~/projects/shared-types --workspace payments
```

The same repository retains its identity and index across memberships. `--no-index` registers without starting a scan.

## Check scope and evidence

From inside backend, compare:

```bash
contextos query "Where is payment status defined, processed, and displayed?" --json
contextos query "Where is payment status defined, processed, and displayed?" --all-repos --json --max-tokens 4000
contextos query "Where is payment status defined, processed, and displayed?" --workspace payments --explain --max-tokens 4000
contextos query "Where is payment status defined, processed, and displayed?" --repo backend --repo frontend --json
```

Confirm unfiltered results stay in backend, combined results cite the relevant repositories, and explicit filters exclude other repositories. Repositories need not contribute equally when they have no relevant evidence. Shared global content retains its separate namespace.

Check your most important exact-symbol queries and several broad architectural queries against your current installation. Inspect `--explain` for strategy contributions and the modest active-repository preference. Graph expansion stays inside each repository.

Unknown repository/workspace names, repositories outside an explicitly selected workspace, and `--repo` combined with `--all-repos` must fail. Outside a repository, queries require an explicit selector.

## Test one MCP server

Use one MCP entry pointing to the local build:

```json
{
  "mcpServers": {
    "contextos": {
      "command": "node",
      "args": [
        "/absolute/path/to/ContextOS/dist/bin/contextos.js",
        "serve", "--workspace", "payments", "--repo", "backend"
      ]
    }
  }
}
```

Call `get_context` with no scope, with `repo: ["backend", "frontend"]`, and with `all_repos: true`. The unfiltered call defaults to backend; an explicitly scoped request does not change that default. `workspace: "payments"` also selects every member.

Follow frontend results with `ctx_read_file`, `ctx_expand`, and `ctx_symbol`, specifying `repo: "frontend"` for relative paths or symbol names. Absolute file reads can resolve to an available workspace member. Paths escaping registered roots, including through symlinks, must fail. `ctx_execute` targets one repository and retains existing script permissions.

Open a second MCP client with frontend active. Verify its default scope and session notes do not inherit the first client's state. Repository facts are intentionally shared across clients of the same repository. `ctx_remember` returns qualified fact references; forgetting a bare historical fact ID targets the active repository.

## Test updates, failure, and recovery

1. Keep the workspace server running. Edit, add, and delete different files in three repositories. Repeat retrieval until changes appear; verify other repositories remain unchanged.
2. Change a file while its repository is being indexed. Verify watcher replay retains the final version.
3. Run `contextos reindex --repo backend`. Verify frontend/shared-types continue to answer and backend memories survive.
4. Add a repository while the server runs. Membership refresh should make it available without restarting the client.
5. Run `contextos repo remove frontend --workspace payments`. New calls must exclude it. Its local database and membership in `default` remain intact. Re-add it and verify the same ID returns.
6. Temporarily make one registered repository unavailable. Combined retrieval should mark partial results; selecting only unavailable repositories should fail.
7. Restart the workspace daemon and repeat queries. IDs, facts, and successful indexes should persist. A new watcher reconciles changes made while the daemon was stopped.
8. Copy a checkout including its index and register the copy under a unique name. It must receive a distinct ID and require reindexing before exposing copied absolute source paths.

Start or stop workspace daemons with:

```bash
contextos daemon start --workspace payments
contextos daemon status --workspace payments
contextos daemon stop --workspace payments
```

Existing repository-scoped `init` and `serve` remain supported. Legacy `watch -w <label>` enrolls the current directory when that workspace is new or empty, and delegated watches stay in the foreground until stopped. Stop an older live daemon before letting the new indexing owner manage that repository.

## Storage, backup, and comparison

The registry is `~/.contextos/registry.db`; repository indexes remain at `<repo>/.contextos/index.db`. Schema v7 preserves local chunk IDs, embeddings, feedback, and memories while adding repository ownership. Legacy `workspaces.json` is imported once and retained with a `.backup` file.

Stop relevant daemons and back up SQLite databases with their WAL/SHM files before testing against important saved memories. Export/import retains repository identity; importing a registered repository's export into an unrelated repository is rejected.

`validation/contextos-1.1.1-workspace.json` records the local comparison with a built v1.1.0 checkout. Reproduce it with:

```bash
node scripts/bench/workspace.mjs --baseline-dir /absolute/path/to/built-v1.1.0
```

Performance numbers describe the checked-in fixtures and this environment. Compare against larger real repositories during your testing. No release action is part of these commands.
