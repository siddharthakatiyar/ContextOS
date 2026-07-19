# ContextOS

AI coding assistants waste thousands of tokens searching large codebases, often missing the files that actually matter.

ContextOS indexes your repository into a semantic graph so agents like Cursor, Claude Code, and Codex retrieve only the relevant functions, classes, documentation, and dependencies—reducing token usage while improving accuracy.

Instead of sending entire files, ContextOS sends only the code the model actually needs.

**Current version: 0.7.1**

## Why ContextOS?

Instead of relying on ripgrep and whole-file context, ContextOS understands your repository at the semantic level.

- ✓ **Function-level retrieval** (AST symbols + large template-literal consts)
- ✓ **Sub-chunked large symbols** — oversized functions keep a parent chunk plus additive line-ranged segments (comment-derived segment titles)
- ✓ **Refactor-for-retrieval** — large scorers/compilers split into named helpers so deep markers stay intact
- ✓ **Hybrid search** — FTS5 + symbol/filename boosts + RRF fusion (optional local embeddings)
- ✓ **Automatic dependency expansion** via the relationship graph
- ✓ **Precision-first compile** — top-K full bodies + path:line stubs under a token budget
- ✓ **Cheap expand path** — stubs carry line ranges; `ctx_read_file` supports ranged reads; `get_symbol` for one symbol
- ✓ **Cross-session memory**
- ✓ **Incremental indexing** with stable chunk IDs and line ranges
- ✓ **Local-first (SQLite + FTS5 + optional sqlite-vec)**
- ✓ **Confidence-gated embeddings** — emb kNN only when keyword confidence is low (or when explicitly enabled)
- ✓ **Works with Cursor, Claude Code, and any MCP client**

## Quick Start

```bash
npm install -g @siddharthakatiyar/contextos

cd my-project

contextos init

contextos serve
```

Open Cursor or Claude Code and start asking questions.
That's it.

After upgrading, reindex so schema and chunking changes take effect:

```bash
contextos reindex
```

## The Problem: Traditional vs. ContextOS

| Traditional (Grep + Read) | ContextOS |
|---|---|
| Line hits, then whole-file Reads | Semantic symbols in one call |
| ripgrep | FTS5 + RRF + graph + filename/symbol boosts |
| Stateless | Learns over time |
| Manual context | Automatic retrieval |
| Often 2+ tool calls | Typically one `get_context` call |

### 100-Query Independent Benchmark (Redis 7.x Codebase)

A rigorous 100-query benchmark (50 targeted function queries, 50 broad conceptual queries) was run on the Redis 7.x C codebase (799 files) to compare ContextOS against a proxy of Cursor's built-in `@codebase` search.

*Note: The Cursor proxy uses ripgrep + file extraction since `@codebase` lacks a programmatic API. Real `@codebase` token counts may vary, but the accuracy and efficiency gap remains stark.*

| Metric | ContextOS (0.7.0) | Cursor `@codebase` (Proxy) |
|--------|-------------------|----------------------------|
| **Targeted Accuracy** (Exact function) | **98%** (49/50) | 92% (46/50) |
| **Generic Accuracy** (Conceptual) | **94%** (47/50) | 54% (27/50) |
| **Overall Accuracy** | **96%** (96/100) | 73% (73/100) |
| **Avg Tokens / Query** | **669** | ~6,534 |
| **Total Tokens** (100 queries) | **66,852** | ~653,401 (10× fewer) |

**Key Takeaways:**
- **Surgical Precision:** ContextOS achieves 96% file-level accuracy while using **10x fewer tokens** than traditional multi-file keyword chunking.
- **Near-Flawless Targeted Retrieval:** ContextOS's AST-aware matcher reliably zeroes in on exact function implementations (98% hit rate).
- **Strong Conceptual Retrieval:** ContextOS successfully resolves broad queries (e.g. "How does Redis start up?") to core implementation files 94% of the time, avoiding noise from dependencies or test scripts.



## Real Retrieval Example

**User asks:**
> "How does authentication work?"

**Retrieved Context:**
- ✓ `login()` function (from `src/auth.ts`) — full body
- ✓ Related symbols as one-line stubs (path + signature) when budget is tight
- ✓ Graph-linked helpers / types when relevant

**Total tokens:** typically under the default **1,200** budget *(instead of multi-file Reads totaling thousands)*

## Architecture

```text
          Repository
        (src/, docs/, config/)
                  │
                  ▼
         Tree-sitter Parsers
          Markdown Parsers
                  │
                  ▼
         Semantic Graph Engine
           (SQLite + FTS5 + porter)
           + line ranges / file_stem
           + optional MiniLM embeddings
                  │
                  ▼
 ┌─────────────────────────────────┐
 │ Intent + keyword / stem / symbol│
 │ RRF fusion (+ optional emb kNN) │
 │ Graph expansion                 │
 │ Scoring + containment dedup     │
 │ Query-aware tiered compile      │
 │ Cross-session memory            │
 └─────────────────────────────────┘
                  │
                  ▼
         MCP Server (Stdio)
                  │
                  ▼
       Cursor, Claude Code, Codex
```

## Features

### Indexing

**AST-aware chunks**  
Tree-sitter extracts functions, classes, and methods. Nested methods record `parent_symbol` so class vs method duplication can be deduped at retrieval time. Large top-level template-literal / string constants (e.g. SQL DDL) are indexed as searchable variables. Trivial anonymous lambdas are skipped. Chunks store stable IDs, `start_line` / `end_line`, and `file_stem` for ranking.

**Compact class outlines**  
When a class has methods, the class chunk stores a short member list instead of repeating every method body.

**Local embeddings (index-time)**  
On upsert, chunks are embedded with a local MiniLM model (`@xenova/transformers`) into `sqlite-vec` when available. Indexing is on by default; **retrieval fusion is off by default** (keyword/RRF path is the accuracy baseline). Opt in with `embeddingsRetrieval: true` or `CONTEXTOS_EMBEDDINGS_RETRIEVAL=1`.

### Retrieval

**Multi-strategy matching + RRF**  
FTS5 (porter tokenizer, operator-preserving sanitizer), exact/prefix symbol lookup, filename and path-stem boosts, and intent-aware queries are fused with Reciprocal Rank Fusion. Foreign workspace chunks are down-ranked so other projects in a shared DB do not dominate.

**Graph expansion**  
Seeds from identifiers and top hits expand through the relationship graph (depth/node caps are configurable), including import edges.

**Containment dedup**  
If both a class outline and its methods survive ranking, oversized class bodies yield to methods; scores are merged.

### Context assembly (compile)

**Tiered, precision-first output**  
- Top-K chunks (adaptive, usually up to 3) render as **full bodies**
- Remaining hits become **stubs with path + line ranges** (`symbol — path/file.ts:12-84`) so agents can `ctx_read_file` or `get_symbol` instead of whole-file Reads
- Query-aware truncation preserves high-signal lines, comments/JSDoc, and branch headers
- Related entities capped; File Structure capped to one chunk
- Framing (headers / fences) counts toward the token budget (`gpt-tokenizer`)

**Diagnostic header**  
`get_context` prefixes a single line: `ContextOS | tokens: N/M`. When stubs remain, a one-line footer steers agents to `get_symbol` / ranged `ctx_read_file`.

### Memory

**Adaptive learning**  
Agents can rate chunks; feedback adjusts future scores (including implicit signals).

**Cross-session memory**  
Facts learned via `learn_fact` / knowledge tools persist across sessions and can appear in `get_context`.

### Developer Experience

**CLI**  
`init`, `reindex`, `serve`, `query`, `status`, `watch`, `visualize`, and more.

**MCP tools**  
`get_context`, `save_context`, `reindex_context`, `get_neighbors`, `get_symbol`, `ctx_execute`, `learn_fact`, `forget_fact`, `rate_chunk`, and related helpers.

**Zero-config setup**  
`contextos init` indexes the repo, writes MCP config if missing (does not overwrite an existing `contextos` MCP entry), and can start the background daemon.

## Configuration

Defaults live in `src/config/defaults.ts` and can be overridden via:

- `~/.contextos/config.json` (global)
- `.contextos/config.json` (repo)
- Env: `CONTEXTOS_EMBEDDINGS=0` disables embedding; `CONTEXTOS_EMBEDDINGS_RETRIEVAL=1` enables emb fusion at query time

Array keys in config use `!` prefix overrides where documented (replace rather than merge).

| Key | Default (0.7.0) | Notes |
|-----|-----------------|--------|
| `maxTokenBudget` | `1200` | Default compile budget; `get_context` `max_tokens` still accepts up to `8000` |
| `maxRetrievalResults` | `12` | Cap on scored chunks before compile |
| `ftsLimit` | `15` | Per-query FTS hit limit |
| `maxChunkTokens` | `1500` | Soft cap when creating chunks |
| `maxSymbolChunkTokens` | `900` | Function/method bodies above this also emit additive segment chunks |
| `layerBoosts` | session 1.5 / repo 1.3 / workspace 1.1 / global 1.0 | Multiplicative score boosts |
| `graphExpansionDepth` | `2` | Relationship walk depth |
| `graphExpansionMaxNodes` | `20` | Cap on expanded entities |
| `diversityDecay` | `0.7` | Penalty for many chunks from one file |
| `diversityPenaltyStart` | `3` | Start applying diversity decay after N chunks/file |
| `embeddingsEnabled` | `true` | Index-time local embeddings (`CONTEXTOS_EMBEDDINGS=0` to disable) |
| `embeddingsRetrieval` | `false` | Fuse emb kNN into RRF (`CONTEXTOS_EMBEDDINGS_RETRIEVAL=1` to enable) |

### `get_context` parameters

| Param | Default | Description |
|-------|---------|-------------|
| `prompt` | required | Task or question |
| `max_tokens` | `maxTokenBudget` (1200) | Compile budget; max 8000 |
| `layers` | `session`, `workspace`, `repo` | Add `global` only when you need shared/third-party context |
| `output_format` | `markdown` | Or `xml` |

## CLI cheatsheet

```bash
contextos init                 # Index + MCP config (preserves existing contextos MCP entry)
contextos reindex              # Wipe local DB and re-init (needed after upgrades)
contextos reindex --embeddings # Backfill vectors without wiping the DB
contextos serve                # MCP stdio server
contextos query "..."          # Test retrieval locally
contextos status               # Index stats
contextos watch                # Live re-index on file changes
```

## Supported Languages

ContextOS leverages Tree-sitter for robust parsing. Supported out of the box:
- ✓ TypeScript / JavaScript (incl. TSX/JSX)
- ✓ Go
- ✓ Python
- ✓ Java
- ✓ C / C++
- ✓ Rust
- ✓ Markdown
- ✓ Common config formats (JSON, YAML, TOML, …)

## Quantifiable Benefits

- **10X Token Efficiency:** 66.8k total tokens across 100 queries vs ~653k using multi-file extraction proxies.
- **98% Precision on Exact Functions:** The AST-aware matcher reliably finds implementation bodies instead of grepping test files.
- **Robust Conceptual Retrieval:** Resolves broad queries accurately 94% of the time.
- **Low latency:** Local SQLite FTS5 retrieval typically completes in milliseconds.
- **Cost savings:** Smaller prompts for API-backed agents mean significantly lower spend per query, and fewer API round-trips.

## Upgrading to 0.7.1

1. Install / update the package (`npm install -g @siddharthakatiyar/contextos@0.7.1`).
2. Restart the ContextOS MCP server in your IDE.

New in 0.7.1: **Deterministic Ranking & Configurable Pipeline**. All sort operations in the retrieval pipeline now use a stable content-hash tiebreaker so query results are identical across sessions and after re-index. Introduces a `pipeline` config block letting you toggle individual retrieval stages (`graphExpansion`, `embeddingFusion`, `containmentDedup`, `diversityFilter`) from `.contextos/config.json` without code changes.

## Upgrading to 0.7.0

1. Install / update the package (`npm install -g @siddharthakatiyar/contextos@0.7.0`).
2. Run `contextos reindex` so helper splits and comment-derived segment titles are indexed.
3. Restart the ContextOS MCP server in your IDE so it loads the new binary.

New in 0.7.0: **Schema Diet & Surface Optimizations**! Reduced the MCP protocol tool surface by merging tools (`ctx_remember`, `ctx_topics`, `ctx_symbol`) and trimming massive descriptions. Added **SentRegistry Deduplication** to prevent duplicate chunk spamming during long conversations (emits `(sent earlier, unchanged)` stubs). Added **Memory Gating** to intelligently filter memory injection by relevance and intent, stopping session log bleed. Added **Tokenizer Calibration** to align token tracking with real-world agent behavior.

## License

ISC
