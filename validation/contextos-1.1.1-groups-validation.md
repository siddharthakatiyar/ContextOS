# ContextOS 1.1.1 groups and worktrees validation

This is the earlier validation record. The candidate was subsequently hardened
and tested against ThrottleX; see [the current report](contextos-1.1.1-throttlex-validation.md)
and `contextos-1.1.1-throttlex-results.json` for current test totals and archive identity.

Local candidate checked on 2026-11-13 with Node v22.23.2 on branch
`codex/groups-worktrees-1.1.1`. Implementation baseline:
`f697419f1b3d285bfdb1d5dac5577d97e7a64864` (merged multi-repository work).
Retrieval comparisons use v1.1.0, commit
`2e77e320a8ffa56268245c9c5ddd5e1cfb7aa358`.

This report supersedes the earlier candidate's test counts in
`contextos-1.1.1-relevance.json`. No publication, release, tag creation, or push
was performed for this candidate. Laptop testing remains pending.

## Automated checks

| Check | Result |
| --- | --- |
| TypeScript build | Passed |
| ESLint, zero warnings | Passed |
| Prettier check | Passed |
| Full suite with V8 coverage | 69 files, 349 tests passed |
| Documentation lint and production build | Passed |
| Production dependency audit, critical threshold | Passed; 2 low and 5 moderate findings remain |
| Diff whitespace check | Passed |
| Installed archive smoke test | Passed |

Coverage: statements 72.29%, branches 65.30%, functions 78.56%, lines 74.50%.

The suite covers global registration and legacy migration, concurrent identity
and membership operations, checkout discovery and branch isolation, separate
view indexing, lease ownership, watcher replay, stale checkout rejection,
cleanup recovery, scoped retrieval, evidence validation, knowledge cleanup,
MCP connection isolation and legacy tool compatibility. The upgrade stop-command
test verifies that older repository daemons can be stopped without first opening
the migrating registry. A real socket connection test also covers Unix homes
whose full socket paths would exceed the operating-system limit.

## Retrieval and performance

The existing retrieval benchmark passed all 9 cases. Recall@10 remained 1.0 and
MRR@10 remained 0.8888888888888888, matching the v1.1.0 baseline.

The four-project payment fixture includes definition, processing, display and
unrelated infrastructure evidence. All 400 repository-scoped ranking comparisons
matched the baseline; combined payment role recall@10 was 1.0.

| Warm p95 measurement | Result |
| --- | --- |
| Baseline single project | 8.198 ms |
| Candidate single project | 8.321 ms; +1.50%, within 10% gate |
| Combined group | 32.039 ms |
| Sum of individual queries | 31.942 ms; group overhead +0.31%, within 20% gate |

See [machine-readable measurements](contextos-1.1.1-groups-performance.json).
Measurements used 20 warmup and 100 measured iterations per scope on this server.
These are deterministic keyword fixtures with embeddings disabled. Embedding
scope/routing behavior is tested with controlled fixtures; a real embedding model
was not downloaded or benchmarked. Laptop and larger-corpus performance should
be checked during manual testing.

## Local install artifact

Package: `.tmp/groups-worktrees-1.1.1/siddharthakatiyar-contextos-1.1.1.tgz`

- Version: `1.1.1`
- Size: 361509 bytes
- SHA-256: `8f29f64e2ac6efa194f272c0a69ffc3e6a233f1885ca9609ad0e51f003ced7d0`

The final archive was installed into a temporary isolated prefix, including its
native SQLite dependency. The installed CLI passed version checking, group
creation, project registration and indexing, group retrieval, daemon stopping,
and verification that data appeared globally without creating a project-local
`.contextos` directory. The optional ONNX runtime CUDA install was skipped and
embeddings were disabled for this smoke test.

## Manual handoff

Follow [the laptop testing checklist](../MULTI_REPOSITORY_TESTING.md) for actual
repositories, worktrees, branch switches, concurrent MCP clients, verified links,
legacy migration, watcher updates, cleanup and recovery. Agent-saved semantic
claims still require the agent to inspect evidence; freshness and scope checks
cannot establish the meaning of arbitrary source code by themselves.

Release remains pending until the user completes testing and explicitly
authorizes publication.
