# Verified cross-project tracing and on-demand inspection

Implemented on `codex/verified-cross-project-tracing`, based on main commit
`be8e326`. Package metadata remains 1.1.1. This work does not publish a package
or release, and does not add an automatic agent discovery pass.

## Behavior

- `ctx_trace` traverses recorded verified links using deterministic breadth-first
  witness paths. It supports outgoing, incoming and bidirectional traversal,
  relationship filters, an optional target, and depth/node/edge/path limits.
  Reverse steps retain the original edge direction. Each node carries project,
  branch/worktree, relative path, available source lines and fresh evidence.
- Tracing reports missing recorded connections and unavailable/stale evidence.
  Traversal limits mark partial/truncated results. Unknown edges are never
  manufactured. Scope exclusions do not disclose excluded references.
- `ctx_resolve_import` inspects one existing import. It supports relative JS/TS
  imports, explicit `file:`/`link:` dependencies, exact package export entries and
  basic import/require/types conditions, and local Go module replacements.
  Source, target and manifest evidence must already be indexed and current.
- Resolving an export location does not prove symbol consumption. Responses
  explicitly distinguish module-import evidence from symbol-usage verification;
  agents must inspect bindings/call sites before saving the stronger claim.
- `ctx_contract` reads an indexed OpenAPI JSON/YAML or protobuf contract. It
  supports exact HTTP operation lookup, optional schema output, fully qualified
  gRPC operations and client/server streaming signatures. External `$ref` values
  remain source evidence and are not fetched automatically.
- Inspection tools do not save connections. Agents continue to use `ctx_link`
  during ordinary work once they have established the relationship.
- Combined retrieval inspects at most three retrieved JS/TS files and six literal
  imports per request. Exact local file mappings with fresh evidence are saved
  with deterministic provenance; unresolved local imports are transient
  `linkSuggestions`, without guessed endpoints. Symbol consumption still needs
  agent verification. Existing agent-written links are preserved.
- Default indexing now includes `.proto` and `go.mod`. OpenAPI operations and
  schema definitions receive searchable chunks. The indexer version advances
  from 1 to 2 so normal readiness checks rebuild selected old views.
- Managed `AGENTS.md` and the MCP handshake describe the tools and gradual
  knowledge-growth workflow. Existing `CLAUDE.md` import behavior is retained.

## Agent onboarding and diagnostics

Global npm installs now add user-wide instructions for detected supported agents
by default; local installs leave global files unchanged. `contextos enable`
refreshes this setup and supports `--dry-run`, `--agent` and `--json`.
`CONTEXTOS_GLOBAL_INSTRUCTIONS=0` opts out during installation. Global guidance
asks before enrolling a new project, including in automatic mode. Existing
project enrollment still uses `contextos init`; permissions are never changed.

`contextos setup --check --json` inspects registration without creating state.
`contextos init --json` emits one JSON result and indexing progress on stderr.
Native project registrations cover detected Codex, Grok, OpenCode, Antigravity
and Gemini clients. OpenCode JSONC is preserved with a manual configuration note.
Cursor's global User Rules require its settings UI; the command prints guidance.
Managed blocks preserve user text and remain safe to repeat.

Doctor inventories discoverable instructions/imports, registered project,
branch/worktree and readiness, MCP registrations and separate retrieval/write
permission observations. `--client codex --noninteractive` explains static
prompt requirements; effective session and managed/runtime policy remain unknown.
No configuration secrets are included in parse errors.

## Validation

On Linux with Node 22.23.2:

- Full coverage suite: **475 tests passed across 81 files**, using
  `npx vitest run --coverage --testTimeout 120000`.
- Coverage: 75% statements, 68.31% branches, 81.12% functions, 77.2% lines.
- Build, lint, formatting and whitespace checks passed.
- Existing retrieval benchmark: **9/9 cases passed**, 100% expected-file recall.
- Real SQLite/indexer fixtures exercise a four-project API/publisher/event/
  consumer chain, incoming/outgoing traversal, cycles, filters, scope isolation,
  bounds, stale evidence and temporarily unavailable sources.
- Import fixtures exercise Node local package exports, types, Go block imports
  and replacements, relative cross-project imports, stale manifests, excluded
  projects, ambiguous files, private symbols, blocked/environment-specific
  exports, and rejection of arbitrary registry/workspace package matching.
- Contract fixtures exercise JSON/YAML, Swagger 2/OpenAPI 3, external references,
  protobuf comments/options, multiple services, streaming, source line ranges,
  malformed definitions, cyclic YAML aliases and inspection size limits.
- MCP client/server tests exercise all three tools and confirm that inspections
  do not populate the relationship database.
- Production dependency inspection includes `js-yaml@4.3.2` and `argparse@2.0.1`.
  The critical audit gate passes; npm still reports 2 low and 5 moderate findings.

Raw results are retained in `.tmp/cross-project-tracing-coverage.log`,
`.tmp/cross-project-tracing-benchmark.log` and
`.tmp/cross-project-tracing-audit.log`.

The four-project comparison against `main@be8e326` retained identical rankings
in **400/400 scoped comparisons** and all three payment roles in the top 10.
Single-source p95 was 8.99 ms versus 8.29 ms on main (+8.46%); workspace p95
was 34.45 ms versus a 34.55 ms individual-source sum. All fixture gates passed.
See [the raw workspace report](cross-project-workspace-benchmark.json).

Separate exact-import fixtures used five warmups and 50 measured rounds, with
embeddings disabled. Combined p95 was 21.83 ms versus an 18.25 ms individual
sum for non-Git projects (1.196x), and 20.27 ms versus 17.04 ms for Git projects
(1.189x). These small-fixture measurements are near the 1.2x threshold and are
not a promise for every workload. See [raw samples](import-learning-latency.json).
Source freshness checks now read Git refs directly rather than starting Git for
every evidence record; loose/packed refs, worktrees, detached HEAD, malformed
refs and access failures have dedicated tests. Reftable evidence is unsupported
and fails closed. Explicit missing exports and version-specific Go replacements
are never guessed; nested registered projects are resolved by their owner.

The fresh-session model gate **has not passed**. Codex loaded the real project
instructions and attempted retrieval first, but its noninteractive approval
policy rejected the MCP calls; it then searched source directly. Claude Code
and Grok Build have no active native login here. Correct link saving, later
session reuse, and edited-evidence rejection remain unverified through these
native clients. Direct MCP/indexer tests cover those storage behaviors.
See [the session report](fresh-agent-sessions.md) and
[machine-readable evidence](fresh-agent-sessions.json). Only fixture-owned
server processes were stopped after the test.

The packed 1.1.1 CLI passed isolated version/help/setup and global postinstall
checks with five simulated agents, repeat installation, local install, opt-out,
and Antigravity/Gemini project registration. It used the workspace dependencies,
so this is not a clean dependency-install test. The package is
`.tmp/cross-project-tracing/siddharthakatiyar-contextos-1.1.1.tgz`.

## Local use

Build with `npm run build`, then configure your MCP client to run
`node /absolute/path/to/ContextOS/dist/bin/contextos.js serve --group payments`
with an appropriate active project. Restart an existing MCP connection to load
the new tool definitions. Use `contextos init` from the new build to refresh
managed agent guidance in an existing checkout.

1. Obtain current view IDs/generations with `ctx_scope` and qualified references
   with `get_context` or `ctx_symbol`.
2. Inspect one dependency with `ctx_resolve_import`, or a selected HTTP/gRPC
   operation with `ctx_contract`. Inspect the source binding, generated client,
   routing configuration or implementation as needed.
3. Save established connections with `ctx_link` and current generations. Leave
   uncertain connections unsaved.
4. Call `ctx_trace` with a start reference, selected group and optional target.
   Check the ordered steps, original edge direction, evidence and partial flags.
5. Edit a supporting file and verify stale evidence is no longer returned.

## Limits

This is an on-demand inspection and recorded-graph tracing implementation.
There is no autonomous workspace crawl, inferred graph, confidence scoring or
automatic HTTP/client/generated-code linking. Wildcard and re-export chains,
environment-dependent package exports, registry/workspace package selection,
Go workspace overrides and other languages' module systems require agent
inspection. Go export lookup locates a unique indexed definition in the exact
declared replacement package; it is not a compiler or runtime-use proof.

OpenAPI operation/schema citations conservatively cover the full original
contract; protobuf RPC citations retain exact signature line ranges. Protobuf
inspection extracts service/RPC signatures and type names, not a complete
protoc descriptor or cross-file message type resolver. Traces return shortest
witness paths rather than every possible path. Responses have structural
traversal bounds; they do not introduce a separate token-budget compiler.

macOS and Windows were not run during this local change. Previous main-branch
CI covered the underlying registry/runtime on Linux and macOS; new portability
checks remain for CI when this branch is pushed.

## Fresh-session release test

Build the candidate, then run:

```bash
node scripts/agent-release-test.mjs --prepare
node scripts/agent-release-test.mjs --run
```

The harness uses four task-owned Git repositories and private ContextOS homes
under `.tmp/fresh-agent-release/`. Native authentication remains with each client;
credentials are never copied into reports. All clients receive the same initial
architecture question without naming ContextOS. The protocol audit checks
successful retrieval before broad search, opaque endpoint identities, saved
link results, actual reuse in a new session and disappearance after an evidence
edit. Empty/error responses, mismatched client request IDs and wrong scopes do
not count as success. `--run` exits nonzero unless every client's gate passes.
`--report` regenerates the report from retained evidence without another model
call. Do not publish based on the unit suite alone; the native gate remains
pending usable client authentication and permissions, plus user testing.
