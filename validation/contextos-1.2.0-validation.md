# ContextOS 1.2.0 validation

Validated on 2026-11-15 using Node 22.23.2 on Linux. The release uses the existing multi-project, group, worktree and verified-knowledge implementation, with corrections for first-query JSON output and installation-time daemon replacement.

## Automated and artifact checks

| Area | Result |
| --- | --- |
| TypeScript build, lint, formatting | Passed |
| Unit/integration suite | 491 tests across 82 files passed; coverage run also passed |
| Coverage | 75% statements; 68.31% branches; 81.12% functions; 77.2% lines |
| Installed-package gate | 10/10 passed, including a live upgrade from published 1.1.1 |
| Documentation lint and production build | Passed; 45 pages generated |
| Four-repository retrieval benchmark | Definition, processing and display evidence present in the top 10; all three citations compiled |
| Existing retrieval examples | 9/9 queries passed; 20/20 expected files retrieved |
| Real-component lifecycle checks | 17/17 passed against disposable copies of ThrottleX sources |
| Verified graph lifecycle | 7/7 passed, including generation rejection and evidence invalidation |
| Import/export edge cases | 9/9 passed, including provenance rejection without destination mutations |
| MCP default/legacy tool configurations | 15/15 and 17/17 checks passed with independent clients |
| Git/worktree and watcher lifecycle | 11/11 passed, including linked/detached worktrees, branch switching, delegation, atomic replacement, rename, deletion, restart and cleanup |
| Config, layers and compatibility aliases | Passed with separate initialized Git fixtures and an isolated home |
| Real embedding inference | Two finite, normalized 384-dimensional vectors from all-MiniLM-L6-v2 |
| Production advisory gate | No high or critical advisories; five moderate and two low transitive/workspace advisories remain |

The real-project checks used copied sources or a disposable clone. Original ThrottleX projects were not modified. Fixture daemons, watchers and registries use isolated homes.

## Installed package gate

`scripts/release-package-test.mjs` installs the actual tarball globally into a fresh prefix and home, without borrowing the checkout's `node_modules`. CI and the publishing workflow run it before publication and upload its JSON report. [The local package report](contextos-1.2.0-package.json) records the tested archive hash and results.

It checks global instruction adapters, legacy schema-v6 migration and memory retention, strict cold/warm JSON queries, fresh-project non-initialization, four independent Git projects plus a worktree, scope rejection, grouped ranking and provenance, two stdio MCP clients, session isolation, Markdown/XML token budgets, exact import inspection, OpenAPI inspection, verified links and traces, memory retention through reindex, watcher updates, path containment, live membership refresh and removed-worktree cleanup.

When given the published 1.1.1 tarball, it also starts that release with an active MCP client, upgrades the same global installation to 1.2.0, verifies the previous daemon exits and checks that the existing client reconnects with its saved knowledge intact.

```bash
npm run build
npm pack --pack-destination /tmp
npm pack @siddharthakatiyar/contextos@1.1.1 --pack-destination /tmp
node scripts/release-package-test.mjs \
  /tmp/siddharthakatiyar-contextos-1.2.0.tgz \
  /tmp/contextos-1.2.0-package-test.json \
  /tmp/siddharthakatiyar-contextos-1.1.1.tgz
```

The first cold-query test reproduced stdout contamination before the stderr correction. The live-upgrade test reproduced a surviving old daemon before the installation correction: 1.1.1 reads the version from the on-disk manifest after npm replaces it. First setup for a new revision now restarts the authenticated, verified owner even if that reply matches the new version. New daemons capture their version at startup. No forced termination is introduced.

## Ranking and latency

[Workspace measurements](contextos-1.2.0-workspace.json) compare the four-repository payment fixture with a built **v1.1.0** baseline on the same machine. Embeddings are disabled for deterministic keyword comparison. After 20 warmups, 100 measured iterations produced 400/400 identical repository-scoped rankings and payment-role Recall@10 of 100%.

| Measurement | Result | Gate |
| --- | --- | --- |
| Single-repository baseline p95 | 8.22 ms | — |
| Single-repository candidate p95 | 8.90 ms | At most 10% above baseline; measured 8.27% |
| Combined workspace p95 | 34.36 ms | At most summed individual times plus 20% |
| Sum of individual queries p95 | 34.59 ms | Coordination ratio 0.994 |

These measurements describe the fixture and hardware used; they are not a performance guarantee for every repository. [Existing retrieval results](contextos-1.2.0-retrieval.json) record the separate nine-query benchmark. No corpus-wide MRR claim is made beyond the unchanged fixture rankings.

## External client limitations

The native fresh-session test was attempted again. Codex's noninteractive approval policy blocked its MCP calls; Claude Code and Grok lacked authentication. Consequently, automatic adoption, native-agent relationship creation and later native-session reuse are **not certified** by this environment. No client permission or credentials were changed. See [the native-session report](fresh-agent-sessions.md).

The instruction-file adapter test uses executable presence fixtures and verifies files/imports and preservation of user text. It does not certify every supported agent's UI or native runtime. Cursor still requires its documented manual User Rules step. Windows is not included in this validation; automatic live-process verification remains limited to Linux/macOS. Visualize output was checked as generated HTML, without an interactive browser test.

## Local user check

Install `@siddharthakatiyar/contextos@1.2.0`, reconnect the coding agent, then run `contextos setup --check --json` and `contextos doctor --client <client> --noninteractive` in a known project. Add local projects to a group and compare ordinary, group and worktree queries using [the testing guide](../MULTI_REPOSITORY_TESTING.md). New projects still require `contextos init`; global installation does not initialize arbitrary directories.
