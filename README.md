# ContextOS

ContextOS is an intelligent context engine designed for AI coding assistants. It indexes codebases, documents, and config files into a local semantic graph, providing AI agents with high-relevance, token-efficient context. It significantly reduces token usage while maximizing context quality for complex architectures.

## Features

- **Multi-Layer Architecture:** Organizes context into `global`, `workspace`, `repo`, and `session` layers to ensure separation of concerns.
- **Intelligent Indexing:** Tree-Sitter based parsers perfectly extract semantic symbols (`function`, `class`, `interface`) from code, and regex-based parsers extract sections from markdown.
- **Graph Expansion:** Automatically discovers dependencies and related symbols to fetch missing context the AI hasn't explicitly asked for.
- **Smart Scoring:** Uses BM25 keyword matching combined with heuristic importance scores (e.g., `README.md` and `package.json` get boosted).
- **Session Memory:** Remembers past user queries and AI context to maintain continuity.
- **MCP Integration:** Exposes tools (`get_context`, `save_context`, `index_files`, `get_neighbors`, `ctx_execute`) to Model Context Protocol compatible clients like Cursor and Claude Desktop.
- **Team Graph Sharing:** Export and import the graph to share knowledge bases across the team.

## Installation

ContextOS requires Node.js 18+.

```bash
npm install -g @siddharthakatiyar/contextos
```

## CLI Usage

### Initialize a project
Create `.contextos` folder and build the initial index.
```bash
contextos init
```

### Watch for changes
Start a daemon to watch the file system and incrementally index changes.
```bash
contextos watch
```

### Start the MCP Server
Start the Model Context Protocol stdio server to connect to an AI assistant.
```bash
contextos serve
```

### Query Context (Test via CLI)
Query the context engine directly to see what the AI will receive.
```bash
contextos query "How does the caching system work?"
```

### Analytics
View token usage and query history.
```bash
contextos analytics
```

### Share Graphs
Export and import graph state for your team.
```bash
contextos export graph.json
contextos import graph.json
```

## Capabilities & Quantifiable Benefits

ContextOS is designed to act as the "brain" for your AI coding assistants (like Cursor, Claude Code, or anything supporting MCP). Instead of relying on traditional file-level inclusion or naive string searching, ContextOS operates at the semantic level.

### 🧠 Core Capabilities
1. **Intelligent Chunking:** Uses **Tree-Sitter** to parse code down to the precise AST level (functions, classes) and Markdown to the heading level.
2. **Graph Expansion:** If the AI asks for a specific function, ContextOS dynamically pulls in the dependencies, types, and imports that the function relies on via graph traversal.
3. **Sandbox Execution:** ContextOS provides the AI with a `ctx_execute` tool, allowing the AI to safely test build scripts or commands inside an isolated environment before writing permanent code.
4. **Heuristic Scoring:** Understands that a `package.json` or `engineering.md` is inherently more important context than a minified build file, routing the most crucial knowledge to the AI first.

### 📉 Quantifying the Impact
Traditional AI workflows rely on pasting entire files. If you need a 20-line function from a 2,000-line file, passing the whole file wastes roughly **15,000 tokens**.

By using ContextOS:
- **Up to 98% Token Reduction:** ContextOS extracts *only* the 20-line functional block and its direct dependencies. Instead of consuming 15,000 tokens, the AI receives a highly concentrated 300-token prompt.
- **Zero "Middle-Loss":** LLMs suffer from "Lost in the Middle" syndrome when given massive files. By strictly capping the context window to pure signal, AI code generation becomes substantially more accurate and less prone to hallucinating variables.
- **Microsecond Latency:** Bypassing slow, repetitive ripgrep searches, ContextOS serves context directly from a local SQLite FTS5 database in `< 10ms`.
- **Cost Savings:** For teams using external API keys (like Anthropic/OpenAI), an 80-98% reduction in prompt token bloat translates to a direct 80-98% reduction in API costs per query.

## License

ISC
