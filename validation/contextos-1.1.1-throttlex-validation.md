# ContextOS 1.1.1: ThrottleX validation

Tested locally on 2026-11-13 with Node v22.23.2 on Linux. The candidate was
installed globally from the local package; nothing was published or released.

## Installation and source boundaries

`/home/siddharthakatiyar/throttleX` is one Git monorepo containing eight component
directories. It is registered as project `throttleX` in group `throttlex`.
Independent-project behavior was tested with disposable Git repositories made
from copies of its real common, control-plane and rate-engine source files.

The initial monorepo scan indexed **139 files, 1,073 chunks and 7,433 local
relationships**. All **1,073 chunks have 384-dimensional embeddings** from the
real `sentence-transformers/all-MiniLM-L6-v2` model. Embedding retrieval opt-in
returned 15 nearest-neighbor hits; keyword-only retrieval was tested separately.

All 211 original tracked files retained their recorded hashes. Initialization
added managed `CLAUDE.md`, `.mcp.json`, `.vscode/cline_mcp_settings.json` and
`.vscode/roo_mcp_settings.json` files and merged the supported global Gemini MCP
configuration. No project-local `.contextos` storage directory was created.
Indexes, registry, graph knowledge and models live under `~/.contextos/`.

The update policy is `notify` so the candidate stays installed for testing. Test
daemons, clients and watchers were stopped; temporary linked worktrees and test
branches were removed. One useful verified edge-to-rate-engine link and its
evidence-backed architecture fact were saved in the real project's knowledge
store and retrieved successfully.

## Executed integration checks

| Check group | Result |
| --- | --- |
| Actual monorepo CLI queries, scopes, errors, diagnostics and budgets | 28/28 passed |
| Actual monorepo MCP operations over stdio | 8/8 passed |
| Installed package: default MCP tools | 15/15 passed |
| Installed package: legacy MCP tools | 17/17 passed |
| Two stdio clients, active defaults, session isolation, membership refresh, shutdown | 5/5 passed |
| Real linked/detached worktrees, branch isolation, watchers and cleanup | 11/11 passed |
| Independent project lifecycle, indexing, persistence and legacy migrations | 17/17 passed |
| Per-view export/import provenance and malformed snapshots | 9/9 passed |
| Verified cross-project graph expansion, generations and selective invalidation | 7/7 passed against source and installed builds |
| Configuration precedence, array merging, isolation and global/repo/session layers | Passed |
| Global and project feedback owner routing | Passed |
| Analytics, aliases, status and visualization HTML generation | Passed |
| Read-only update status/policy and upgrade dry-run | Passed; no newer compatible release was available |

Architecture queries retrieved evidence across the gateway/rate-engine call,
queue/worker execution, API-key lifecycle and dashboard policy display. An exact
`CheckRateLimit` query has several legitimate implementations; its definition
check was separated from the explicit caller-to-service architecture query.
Markdown and XML contexts were checked at 100, 400, 1,200 and 4,000 tokens.

The standalone CLI, MCP, lifecycle, graph, configuration and worktree harnesses,
raw reports and logs are retained under `.tmp/throttlex-validation/`. Earlier
failure reports are retained alongside successful reruns.

## Issues found and corrected

- Concurrent registration held the global registry write lock during expensive
  view initialization. Per-view initialization leases now keep that lock short.
- Importing identity-free legacy data could attach foreign source paths to the
  destination project. Imports now validate ownership in every table and reject
  repository path and symlink escapes while preserving valid legacy snapshots.
- Markdown citation framing could exceed the requested token budget. Final
  packing now respects the full rendered limit without cutting code fences.
- MCP expansion returned an access-denial message without an error flag.
- Foreground watchers could silently fail beneath a hidden parent directory or
  delegate only a scan to an existing owner. Both paths now watch actual changes.
- Profile output corrupted JSON on stdout; trace requests did not expose query
  explanations. Diagnostics now preserve machine-readable output.
- Daemon startup used a short fixed retry window. Readiness now has bounded
  connection attempts and a 30-second startup deadline with a diagnostic.
- Legacy feedback could not route qualified shared-global references.
- Sent-content deduplication, automatic MCP config generation and framing
  reserve settings were ignored in parts of the new runtime.
- Zero graph-depth, graph-boost, diversity and layer-weight values fell through
  to defaults. Explicit zero values now retain their meaning.
- Workspace MCP requests used a fixed default budget. Selected-view defaults
  now apply while explicit request limits remain authoritative.
- Configuration schema descriptions still pointed new users to local storage.

## Automated checks and performance

The final automated totals and artifact identity are recorded in
`contextos-1.1.1-throttlex-results.json`: **381 tests passed across 73 files**.
Coverage was 73.25% statements, 66.07% branches, 79.62% functions and 75.47% lines.
TypeScript build, lint and formatting checks passed. The expanded coverage suite was rerun after two I/O-related
timeouts; the CLI integration timeout was adjusted for its sequence of child
processes, and the final coverage command used a 120-second default per test.
Assertions and response budgets were unchanged.

The existing retrieval benchmark passed 9/9 cases. The four-project comparison
retained all 400 scoped rankings and found definition, processing and display
evidence in the top 10. Single-project warm p95 was 8.394 ms versus 8.269 ms for
the baseline (+1.50%); combined p95 was 32.278 ms versus 32.408 ms for summed
individual queries. All corresponding relevance and latency gates passed.

On the real monorepo, a separate 100-query warm run including compilation had
20.03 ms median and 50.79 ms p95. File-descriptor counts remained stable during
the repeated queries and returned below the starting count after closing the
runtime. These timings were recorded before the later server I/O contention;
they are fixture measurements rather than promises for every workload.

During the final pass Linux reported sustained high disk-I/O pressure. One MCP
handshake timed out during that period; it was preserved as a failure and rerun.
The subsequent full actual-project MCP run passed, and automatic startup plus
a query passed separately in 6.58 seconds with a clean shutdown.

## Boundaries and remaining limitations

- `adaptiveResponse` remains a reserved compatibility setting. The workspace
  server uses explicit tiers and token budgets. `globalContextDir` is also a
  legacy compatibility setting: shared indexed content is retrieved, but the
  workspace server does not automatically scan that directory. The schema now
  states these limits.
- The two-full-scan throttle is process-local. Separate CLI processes can
  exceed two scans in total; a machine-wide scan quota was not implemented.
- Export/import is a single-view graph snapshot, not a full backup of groups,
  other views, global knowledge, embeddings, sessions or feedback. Existing
  history is preserved when importing; unrelated identities are rejected.
- Raw `.proto` files are outside the default indexable patterns. Indexed Go
  implementations and documentation can be retrieved, and registered-root
  files can be inspected explicitly with the read tools.
- Editor configuration and MCP protocol behavior were tested. Actual
  Claude/Cursor/VS Code user interfaces, browser rendering of the generated
  graph, Windows and macOS were not exercised in this Linux environment.
- No real upgrade, npm publication, release tag or GitHub release was performed.
  Agent claim semantics still depend on inspecting evidence; server checks
  enforce identity, scope, freshness and provenance.

## Use the installed candidate

```bash
cd ~/throttleX
contextos status --group throttlex
contextos query "Where do delayed requests get queued and executed?" --group throttlex --explain
contextos serve --group throttlex
```

Release remains pending explicit user authorization after testing.
