# Saved knowledge ranking benchmark

Run from the repository root:

```sh
node validation/ranking-benchmark/runner.mjs validation/ranking-benchmark/latest.json
```

The runner executes the Vitest suite using `createFixtureGroup()`: three real Git repositories, isolated HOME, embeddings disabled, indexed fixture code, 36 additional JSON settings files, 15 saved facts and five evidence-backed cross-repository links. The facts describe synthetic fixture policies, not production architecture. Twenty fixed questions cover infrastructure, config rules, billing, repository roles, queue production/consumption and caller relationships. Assertions test the actual in-memory MCP client/server response after compilation and envelope bounding.

Each question has one expected saved item. `firstExpectedRank` is its one-based position in returned compiled `structuredContent.chunks`; `null` means absent. Links qualify only if surfaced as a knowledge hit, not merely present in auxiliary graph metadata. `recallAt5` is the fraction of questions whose expected item appears in the first five hits. `meanFirstExpectedRank` assigns missing items rank 31 (one beyond the default 30-hit cap). `tokens` measures the entire bounded response envelope, including text and structured citations, with a 2000-token limit. The test requires recall@5 >= 0.95, all 20 items surfaced, mean rank <= 3 and max tokens <= 2000. Separate tests exercise default compact output (250 text tokens), XML, explicit smaller envelopes, scopes, evidence freshness and lifecycle ordering.

`baseline.json` was captured before ranking changes on the Wave 0 implementation. Reproduce that historical measurement by copying this benchmark suite (`validation/ranking-benchmark/` and `tests/retrieval-130/benchmark.test.ts`) to a checkout of foundation commit `48088d5`, which already contains the shared fixture helper, then running:

```sh
RANKING_BASELINE=1 node validation/ranking-benchmark/runner.mjs validation/ranking-benchmark/baseline.json
```

`RANKING_BASELINE=1` only disables improvement thresholds; it does not emulate old ranking. UUIDs, temporary paths and worktree citations vary across fresh fixtures, so token counts and equal-score baseline ordering can vary slightly. Ranking is deterministic for a fixed indexed corpus and saved IDs. The tracked artifacts are measured snapshots, not hardcoded expected results.

This fixture benchmark does not substitute for a live run on the reported 52-repository group. No production repositories or saved production knowledge are accessed.
