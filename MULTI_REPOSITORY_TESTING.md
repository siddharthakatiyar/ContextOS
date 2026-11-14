# ContextOS 1.1.1 local testing

Version 1.1.1 is a local testing candidate. It is not published to npm, and no release should be created until local testing is complete and the user explicitly approves it.

The latest completed real-project checks, corrected issues, and remaining limitations are recorded in [the ThrottleX validation report](validation/contextos-1.1.1-throttlex-validation.md).

## Build the candidate

From a ContextOS source checkout, use the supported Node version and the locked dependencies:

```bash
npm ci
npm run build
npm run lint
npm run format:check
npm test
npm run bench
node dist/bin/contextos.js --version
```

The CLI should print `1.1.1`. During local testing, replace `contextos` in the examples below with `node /absolute/path/to/ContextOS/dist/bin/contextos.js`. A version string from the local build does not mean the package has been published.

Alternatively, copy the local package from `.tmp/groups-worktrees-1.1.1/siddharthakatiyar-contextos-1.1.1.tgz` to your laptop and install that exact file:

```bash
npm install -g ./siddharthakatiyar-contextos-1.1.1.tgz
contextos --version
```

Use Node 22.12 or newer. The package installation needs network access for dependencies. This installs the testing candidate without publishing it. Automated results and testing limits are recorded in [the validation report](validation/contextos-1.1.1-groups-validation.md), with latency measurements in [the performance report](validation/contextos-1.1.1-groups-performance.json).

## Initialize projects and create a group

Start with four local projects, for example `backend`, `frontend`, `shared-types`, and `infrastructure`:

```bash
contextos group create payments

cd ~/projects/backend
contextos init --group payments

contextos group add payments ~/projects/frontend
contextos group add payments ~/projects/shared-types
contextos group show payments
contextos project list
contextos project status --workspace payments
```

`init` registers the current project and indexes its available worktrees. `group add` does the same for a new project or attaches a registered project to another group. Each command is safe to repeat. Use `--no-index` to register without starting scans. `contextos repo` is an alias for `contextos project`.

Check that `init` places one managed ContextOS section in `AGENTS.md` and an `@AGENTS.md` import in `CLAUDE.md`, preserving user-written text in both. Repeat initialization to confirm neither is duplicated. For an older project, confirm its recognizable generated ContextOS section moves out of `CLAUDE.md` into `AGENTS.md`.

Global npm installation now installs instructions for detected supported agents by default. Preview with `contextos enable --dry-run --json`; refresh after installing another agent with `contextos enable`. Use `CONTEXTOS_GLOBAL_INSTRUCTIONS=0` during install to opt out. Local installs must leave global instruction files unchanged. Check Cursor's reported manual User Rules step if installed.

Before initialization, `contextos setup --check --json` must report `not_initialized` without creating a registry. After `contextos init --json`, stdout must contain one JSON result with a ready view and current generation; indexing progress belongs on stderr. Run `contextos doctor --client codex --noninteractive` (or `claude`, `grok`, `opencode`, `agy`) to inspect instructions and MCP/permission observations separately. Existing user text and permission settings must remain intact. The global onboarding guidance asks before initializing an unregistered project, including in automatic mode.

Add infrastructure to a separate group or the default group if you want it available to broad searches. A project can join multiple groups without duplicating its index.

## Check scope and ranking

From inside the backend checkout:

```bash
contextos query "Where is payment status defined, processed, and displayed?" --json
contextos query "Where is payment status defined, processed, and displayed?" --group payments --json --max-tokens 4000
contextos query "Where is payment status defined, processed, and displayed?" --project backend --project frontend --explain
contextos query "Where is payment status defined, processed, and displayed?" --group payments --all-worktrees --json
```

Check that an unfiltered query only uses backend. A group query should include one available checkout per project, and `--all-worktrees` should include every available checkout in the group. Infrastructure should appear only when its group or project is selected. Verify that returned chunks include project and branch provenance, a relative source path, and a qualified reference even when separate project indexes reuse the same local chunk ID.

Use several exact-symbol and broad architecture questions. Open the explanations to inspect scope, evidence provenance, strategy contributions, and active-checkout preference. Graph expansion should remain inside the selected views. Unknown groups, projects, or worktrees and invalid combinations should fail with a clear selector error.

## Check Git worktree discovery and branch isolation

Create a feature worktree in one of the fixture projects:

```bash
git -C ~/projects/backend worktree add ~/projects/backend-refunds -b feature/refunds
cd ~/projects/backend-refunds
contextos init --group payments
contextos worktree list --project backend
```

Confirm it has a separate view ID and index. Change a file in the feature checkout and verify a query against that worktree returns the feature content, while a query against `main` returns the main content. Use the explicit `--worktree` selector when selecting one checkout. Switching branches within one checkout should reconcile the view before returning its new content; results from the previous branch must not leak into the new branch.

Also try a detached worktree and uncommitted tracked and untracked files. ContextOS should report the checked-out view and branch/commit state. It should discover worktrees already present on disk; it should not create or switch Git worktrees itself.

## Test one MCP server and agent knowledge

For the new on-demand `ctx_trace`, `ctx_resolve_import` and `ctx_contract` tools,
see [the cross-project tracing validation and local-use guide](validation/cross-project-tracing.md).
Agents inspect and save established connections during ordinary work; there is
no separate automatic agent discovery pass.

Configure one MCP connection to serve the group with backend as its active project:

```json
{
  "mcpServers": {
    "contextos": {
      "command": "node",
      "args": [
        "/absolute/path/to/ContextOS/dist/bin/contextos.js",
        "serve",
        "--group",
        "payments",
        "--project",
        "backend"
      ]
    }
  }
}
```

Call `get_context` without a selector and confirm it uses backend. Then ask it to search `group: "payments"`, a specific project, and a specific worktree. Try `all_worktrees: true` and confirm one request's selector does not change another request's default. Legacy `workspace` and `all_repos` selectors remain available as aliases.

For a concrete connection between projects, inspect both endpoints and the dependency, routing, or contract evidence that establishes the link. Then use `ctx_scope` for view IDs and generations, `ctx_link` to save the verified connection, `ctx_links` to read it back, and `get_context` to retrieve through it. The agent can use `ctx_remember` for durable facts, `ctx_unlink` or `ctx_forget` to correct records, and `ctx_read_file` / `ctx_expand` / `ctx_symbol` to inspect evidence. A matching name or route by itself should not create a link; uncertain relationships should remain unsaved.

Create a second MCP client with frontend active. Verify that it has its own default scope and session history. Agent-saved facts and links should persist across clients only in their declared view, project, or group scope. Change or remove supporting code and confirm unsupported links and facts stop appearing.

## Test updates, failures, and recovery

1. Keep the MCP server running. Edit, add, and delete files in several projects. Confirm the correct view updates and unrelated project indexes remain unchanged.
2. Edit a file while its worktree is being indexed. The final content should be indexed after watcher events replay.
3. Start a full scan and switch the active branch. The old job must not write into the new branch view.
4. Remove a feature worktree with Git, then run `contextos clean --dry-run`. Review the listed stale views before running `contextos clean`; confirm graph references, vectors, and stored view data for confirmed removals are cleared.
5. Make a project temporarily unavailable, such as disconnecting an external drive. Its absence alone should not be treated as proof that the project was deleted.
6. Run `contextos project remove backend` to detach group membership and verify project indexes remain. Re-add the project to the group and verify the same identity is reused.
7. In disposable test data, run `contextos project remove backend --purge`. Confirm source files remain and all stored indexes, knowledge, and group memberships for that project are gone.
8. Stop and restart the shared daemon, then repeat retrieval. Check that no stale watchers, sockets, database handles, or indexing jobs remain.

## Storage and migration

New data is stored globally:

```text
~/.contextos/
  registry.db
  graph.db
  config.json
  projects/<project-id>/
    config.json
    views/<view-id>/index.db
  runtime/
```

`registry.db` tracks groups, projects, worktrees, and branch views. Every view has its own index. `graph.db` holds evidence-backed cross-project relationships and facts. Runtime state and the shared daemon live under `runtime/`. New initialization does not create a `.contextos` directory inside a project.

On Unix, an unusually long home path uses a private temporary directory for sockets to stay within operating-system path limits. Persistent project data remains under `~/.contextos/`.

Before testing against important data, run `contextos daemon stop --all` to stop older ContextOS daemons and back up both `~/.contextos/` and any legacy project `.contextos` directories. Registration copies an existing local index into global view storage and leaves the old files in place as migration sources. Legacy workspace registrations are imported into the global registry. Verify saved memories and recent history after migration before removing any old backup yourself.

Group removal retains project data. Explicit project purge deletes stored data but never source files. `clean` removes only views ContextOS can confirm are obsolete; use the dry run first.

## Release gate

Do not publish to npm, create a GitHub release, or push a release tag as part of local testing. Version 1.1.1 remains pending until testing is complete and the user explicitly approves release.
