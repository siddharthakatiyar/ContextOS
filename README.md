# ContextOS

AI coding assistants waste thousands of tokens searching large codebases, often missing the files that actually matter.

ContextOS indexes your repository into a semantic graph so agents like Cursor, Claude Code, and Codex retrieve only the relevant functions, classes, documentation, and dependencies—reducing token usage while improving accuracy.

Instead of sending entire files, ContextOS sends only the code the model actually needs.

## Why ContextOS?

Instead of relying on ripgrep and whole-file context, ContextOS understands your repository at the semantic level.

- ✓ **Function-level retrieval**
- ✓ **Automatic dependency expansion**
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

## The Problem: Traditional vs. ContextOS

Right now, your AI assistant is likely using traditional file searches. Here is how ContextOS compares:

| Traditional | ContextOS |
|---|---|
| Whole files | Semantic symbols |
| ripgrep | Graph traversal |
| Stateless | Learns over time |
| Manual context | Automatic retrieval |
| Line chunks | AST-aware chunks |

## Real Retrieval Example

**User asks:**
> "How does authentication work?"

**Retrieved Context:**
- ✓ `login()` function (from `src/auth.ts`)
- ✓ `jwt.ts` utilities
- ✓ `AuthMiddleware` class
- ✓ `User` database model
- ✓ `README/Auth.md`

**Total tokens:** 287 *(Instead of 15,000+ from whole files)*

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
                  │
                  ▼
 ┌─────────────────────────────────┐
 │ Ranking & Relevance             │
 │ Graph Expansion                 │
 │ Cross-Session Memory            │
 └─────────────────────────────────┘
                  │
                  ▼
         MCP Server (Stdio)
                  │
                  ▼
       Cursor, Claude Code, Codex
```

## Features

### Retrieval

**Semantic indexing**  
Uses Tree-sitter to parse code down to the precise AST level (functions, classes) and Markdown to the heading level. 

**Graph expansion**  
Never forget helper functions again. If the AI asks for a specific function, ContextOS dynamically pulls in the dependencies, types, and imports that the function relies on via graph traversal.

**Context assembly**  
Replaces large chunks with structural summaries instead of simply truncating them. This keeps your context window small without losing the broader architecture.

### Memory

**Adaptive learning**  
Retrieval gets better the more your AI uses it. The AI can tell ContextOS whether retrieved context was useful. ContextOS remembers this feedback and improves future retrieval automatically.

**Cross-session memory**  
Your AI remembers project decisions weeks later. Agents can permanently store project knowledge (e.g., "Authentication uses JWT") and reuse it across future sessions.

### Developer Experience

**Visualization**  
Generate an interactive HTML visualization of your codebase's semantic relationships.

**Zero-config setup**  
Ready in under a minute:
- Initializes ContextOS
- Generates MCP configuration
- Starts background indexing

**MCP integration**  
Exposes tools (`get_context`, `save_context`, `index_files`, `get_neighbors`, `ctx_execute`, `learn_fact`, `rate_chunk`) natively to Model Context Protocol compatible clients.

## Supported Languages

ContextOS leverages Tree-sitter for robust parsing. Supported out of the box:
- ✓ TypeScript
- ✓ JavaScript
- ✓ Go
- ✓ Python
- ✓ Java
- ✓ C++
- ✓ Rust
- ✓ Markdown

## Quantifiable Benefits

- **Up to 98% Token Reduction:** Measured on repositories where agents would otherwise load entire files. By extracting *only* the functional block and its direct dependencies, ContextOS serves a highly concentrated prompt.
- **Microsecond Latency:** Bypassing slow, repetitive regex searches, ContextOS serves context directly from a local SQLite FTS5 database in `< 10ms`.
- **Cost Savings:** For teams using external API keys (like Anthropic/OpenAI), reducing prompt token bloat translates directly to lower API costs per query.

## Screenshots

<!-- Add screenshots here -->
1. **Visualization Graph** - *(Showcase the semantic map of a repository)*
2. **CLI Output** - *(Showcase the blazing fast indexing statistics)*
3. **Cursor MCP** - *(Showcase Cursor calling the get_context tool)*

## License

ISC
