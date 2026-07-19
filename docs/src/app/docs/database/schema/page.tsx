import { DocPage } from "@/components/docs/doc-page";
import { SourceLink } from "@/components/docs/source-link";

export default function SchemaDocs() {
  return (
    <DocPage
      title="SQLite Schema"
      description="The underlying relational structure of the Schema v5 .contextos database."
      prev={{ title: "Context Compression", href: "/docs/algorithms/compression" }}
      next={{ title: "Framework Examples", href: "/docs/examples" }}
    >
      <SourceLink path="src/core/storage/schema.ts" />

      <h2>Why SQLite?</h2>
      <p>
        The typical modern AI stack relies on standalone vector databases (like Pinecone, Qdrant, or Postgres with pgvector). 
        ContextOS intentionally rejects this model for a local, embedded SQLite database.
      </p>
      
      <p>
        <strong>1. Independent Project Isolation:</strong> A global vector DB suffers from cross-contamination. If you search for "UserAuth" on a machine with 5 projects, you will retrieve classes from all 5 projects. SQLite allows us to place a <code>.contextos</code> file directly in the repository, ensuring zero leakage.
      </p>
      <p>
        <strong>2. Graph Traversal Speed:</strong> ContextOS relies heavily on resolving file dependencies. Relational joins in SQLite are orders of magnitude faster for local recursive CTE queries than making network hops to a graph database.
      </p>

      <h2>Schema v5 Tables</h2>

      <h3>1. <code>files</code></h3>
      <p>
        Tracks every file in the repository that has been successfully parsed, including dirty-checking mechanisms.
      </p>
      <pre>
        <code className="language-sql">
{`CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  layer TEXT NOT NULL,
  workspace_name TEXT,
  hash TEXT NOT NULL,
  last_indexed INTEGER NOT NULL,
  importance INTEGER DEFAULT 5,
  chunk_count INTEGER DEFAULT 0
);`}
        </code>
      </pre>

      <h3>2. <code>chunks</code></h3>
      <p>
        A chunk is a specific AST node (e.g., a function, a class, an interface) extracted from a file. Notice how we store deep syntactic metadata (<code>file_stem</code>, <code>parent_symbol</code>, <code>symbol_kind</code>) to allow query-aware filtering.
      </p>
      <pre>
        <code className="language-sql">
{`CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  source_file TEXT NOT NULL,
  layer TEXT NOT NULL,
  workspace_name TEXT,
  section_title TEXT,
  section_depth INTEGER NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  keywords TEXT,
  hash TEXT NOT NULL,
  importance INTEGER DEFAULT 5,
  token_count INTEGER NOT NULL,
  file_type TEXT,
  language TEXT,
  symbol_name TEXT,
  symbol_kind TEXT,
  parent_symbol TEXT,
  start_line INTEGER,
  end_line INTEGER,
  file_stem TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(source_file) REFERENCES files(path) ON DELETE CASCADE
);`}
        </code>
      </pre>

      <h3>3. <code>relationships</code></h3>
      <p>
        The graph edges representing imports and dependencies. Notice the <code>weight</code> column which powers the decay algorithm in the Graph Expander.
      </p>
      <pre>
        <code className="language-sql">
{`CREATE TABLE IF NOT EXISTS relationships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  target TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  weight REAL DEFAULT 1.0,
  source_chunk_id TEXT NOT NULL,
  layer TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(source_chunk_id) REFERENCES chunks(id) ON DELETE CASCADE,
  UNIQUE(source, target, relationship_type, source_chunk_id)
);`}
        </code>
      </pre>

      <h3>4. <code>fts_chunks</code> (BM25 Engine)</h3>
      <p>
        The virtual table powering the BM25 text search. We explicitly utilize the <code>porter unicode61</code> tokenizer and a prefix index of <code>'2 3'</code> to guarantee sub-millisecond keyword matches across large codebases.
      </p>
      <pre>
        <code className="language-sql">
{`CREATE VIRTUAL TABLE chunks_fts USING fts5(
  content,
  summary,
  keywords,
  section_title,
  content=chunks,
  content_rowid=rowid,
  tokenize='porter unicode61',
  prefix='2 3'
);`}
        </code>
      </pre>

      <h3>5. Advanced Systems</h3>
      <p>
        Schema v5 also introduces several advanced tables for opt-in features:
      </p>
      <ul>
        <li><code>chunk_embeddings</code>: Stores dense vectors (BLOBs) for hybrid RRF fusion retrieval.</li>
        <li><code>knowledge_facts</code>: Stores user-provided architectural truths with its own FTS5 index.</li>
        <li><code>session_events</code>: Stores cross-session memory for long-running workflows.</li>
        <li><code>feedback_signals</code>: Tracks explicit upvotes/downvotes to adjust <code>score_adjustment</code> multipliers during retrieval ranking.</li>
      </ul>

    </DocPage>
  );
}
