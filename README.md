# ContextOS

AI coding assistants waste thousands of tokens searching large codebases, often missing the files that actually matter.

ContextOS indexes your repository into a semantic graph so agents like Cursor, Claude Code, and Codex retrieve only the relevant functions, classes, documentation, and dependencies—reducing token usage while improving accuracy.

Instead of sending entire files, ContextOS sends only the code the model actually needs.

**Current version: 0.5.0**

## Why ContextOS?

Instead of relying on ripgrep and whole-file context, ContextOS understands your repository at the semantic level.

- ✓ **Function-level retrieval** (AST symbols + large template-literal consts)
- ✓ **Automatic dependency expansion** via the relationship graph
- ✓ **Precision-first compile** — top-K full bodies + signature stubs under a token budget
- ✓ **Cross-session memory**
- ✓ **Incremental indexing**
- ✓ **Local-first (SQLite + FTS5)**
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
| ripgrep | FTS5 + graph + filename/symbol boosts |
| Stateless | Learns over time |
| Manual context | Automatic retrieval |
| Often 2+ tool calls | Typically one `get_context` call |

### Measured E2E comparison (contextOS repo, 20 architectural queries)

End-to-end tokens include search **and** any follow-up file Reads until the implementation body is present.

| Metric | ContextOS 0.5.0 | Built-in Grep+Read |
|--------|-----------------|--------------------|
| Avg tokens / query | **~1,055** | ~1,622 |
| Search accuracy (1–5) | **5.0** | 3.0 |
| Full body from first call | **20/20** | 0/20 |
| Avg tool calls | **1.0** | 2.2 |

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
           (SQLite + FTS5)
           + parent_symbol links
                  │
                  ▼
 ┌─────────────────────────────────┐
 │ Intent + keyword / stem / symbol│
 │ Graph expansion                 │
 │ Scoring + containment dedup     │
 │ Tiered compile (full + stubs)   │
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
Tree-sitter extracts functions, classes, and methods. Nested methods record `parent_symbol` so class vs method duplication can be deduped at retrieval time. Large top-level template-literal / string constants (e.g. SQL DDL) are indexed as searchable variables. Trivial anonymous lambdas are skipped.

**Compact class outlines**  
When a class has methods, the class chunk stores a short member list instead of repeating every method body.

### Retrieval

**Multi-strategy matching**  
FTS5 full-text search, exact/prefix symbol lookup, filename and path-stem boosts (e.g. `schema` → `schema.ts`), and intent-aware queries. Foreign workspace chunks are down-ranked so other projects in a shared DB do not dominate.

**Graph expansion**  
Seeds from identifiers and top hits expand through the relationship graph (depth/node caps are configurable).

**Containment dedup**  
If both a class outline and its methods survive ranking, oversized class bodies yield to methods; scores are merged.

### Context assembly (compile)

**Tiered, precision-first output**  
- Top-K chunks (adaptive, usually up to 3) render as **full bodies**
- Remaining hits become **one-line stubs** (`kind name — file`) so the agent can `Read` if needed
- Truncation preserves high-signal lines (strategy labels, DDL, key APIs)
- Related entities capped; File Structure capped to one chunk
- Framing (headers / fences) counts toward the token budget

**Diagnostic header**  
`get_context` prefixes a single line: `ContextOS | tokens: N/M`.

### Memory

**Adaptive learning**  
Agents can rate chunks; feedback adjusts future scores.

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

| Key | Default (0.5.0) | Notes |
|-----|-----------------|--------|
| `maxTokenBudget` | `1200` | Default compile budget; `get_context` `max_tokens` still accepts up to `8000` |
| `maxRetrievalResults` | `12` | Cap on scored chunks before compile |
| `ftsLimit` | `15` | Per-query FTS hit limit |
| `maxChunkTokens` | `1500` | Soft cap when creating chunks |
| `layerBoosts` | session 1.5 / repo 1.3 / workspace 1.1 / global 1.0 | Multiplicative score boosts |
| `graphExpansionDepth` | `2` | Relationship walk depth |
| `graphExpansionMaxNodes` | `20` | Cap on expanded entities |
| `diversityDecay` | `0.7` | Penalty for many chunks from one file |
| `diversityPenaltyStart` | `3` | Start applying diversity decay after N chunks/file |

### `get_context` parameters

| Param | Default | Description |
|-------|---------|-------------|
| `prompt` | required | Task or question |
| `max_tokens` | `maxTokenBudget` (1200) | Compile budget; max 8000 |
| `layers` | `session`, `workspace`, `repo` | Add `global` only when you need shared/third-party context |
| `output_format` | `markdown` | Or `xml` |

## CLI cheatsheet

```bash
contextos init          # Index + MCP config (preserves existing contextos MCP entry)
contextos reindex       # Wipe local DB and re-init (needed after upgrades)
contextos serve         # MCP stdio server
contextos query "..."   # Test retrieval locally
contextos status        # Index stats
contextos watch         # Live re-index on file changes
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

- **Lower E2E token use than Grep+Read** on architectural “how does X work?” queries (see table above), by returning the implementation body in one call instead of Grep + mandatory Reads.
- **Low latency:** Local SQLite FTS5 retrieval typically completes in milliseconds.
- **Cost savings:** Smaller prompts for API-backed agents mean lower spend per query.

## Upgrading to 0.5.0

1. Install / update the package.
2. Run `contextos reindex` in each project (adds `parent_symbol`, rebuilds chunks with the new chunker/parser).
3. Restart the ContextOS MCP server in your IDE so it loads the new binary.

## License

ISC
