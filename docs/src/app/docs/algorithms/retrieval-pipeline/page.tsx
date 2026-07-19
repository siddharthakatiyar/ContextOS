import { DocPage } from "@/components/docs/doc-page";
import { SourceLink } from "@/components/docs/source-link";
import { ComplexityTable } from "@/components/docs/complexity-table";

export default function RetrievalPipelineDocs() {
  return (
    <DocPage
      title="Retrieval Pipeline"
      description="The multi-stage architecture ContextOS uses to fetch, expand, rank, and compress tokens."
      prev={{ title: "Initialization Sequence", href: "/docs/initialization" }}
      next={{ title: "Ranking & Tie-Breaking", href: "/docs/algorithms/ranking" }}
    >
      <SourceLink path="src/core/retrieval/index.ts" />

      <h2>Pipeline Overview</h2>
      <p>
        The ContextOS retrieval pipeline consists of four distinct stages: <strong>Keyword Matching</strong>, <strong>Graph Expansion</strong>, <strong>Intent Scoring (Ranking)</strong>, and <strong>Context Compression</strong>.
      </p>

      <ol>
        <li><strong>Query Execution:</strong> A natural language query or specific symbol search is initiated.</li>
        <li><strong>FTS5 BM25 Lookup:</strong> The local SQLite index performs a full-text search across AST chunk bodies, file paths, and symbol signatures.</li>
        <li><strong>Graph Expansion:</strong> ContextOS uses the top hits as seeds for a BFS traversal over the dependency graph.</li>
        <li><strong>Scoring & Fusion:</strong> All retrieved chunks are merged and scored via Reciprocal Rank Fusion (RRF), boosted by Layer logic (Workspace &gt; Global).</li>
        <li><strong>Compression:</strong> The final list of chunks is packed sequentially into the requested token budget.</li>
      </ol>

      <h2>1. Keyword Matching (BM25 Proxy)</h2>
      <p>
        Instead of loading a heavy embedding model (which is slow locally and prone to semantic contamination), ContextOS relies on SQLite's highly optimized <code>FTS5</code> virtual tables using the <code>porter</code> stemmer.
      </p>
      <p>
        We sanitize incoming queries to strip punctuation and build a valid FTS match expression. This guarantees exact matches for technical symbols (e.g. <code>AuthenticationService</code>) while falling back to stemmed matches for natural language (e.g. "authentication").
      </p>

      <ComplexityTable 
        time="O(log N)" 
        space="O(1)" 
        averageCase="~2ms" 
        worstCase="~5ms"
      />

      <h2>2. Graph Expansion</h2>
      <p>
        Once the initial text search returns a list of candidate files, we execute <a href="/docs/algorithms/graph-expansion">Graph Expansion</a>.
      </p>
      <p>
        If the LLM is asking about a function that relies on an interface from another file, FTS alone won't find it. ContextOS traverses the <code>relationships</code> table (derived from AST imports) to pull in those critical peripheral definitions.
      </p>

      <h2>3. Scoring (RRF)</h2>
      <p>
        ContextOS ranks results by merging three separate signals:
      </p>
      <ul>
        <li><strong>Text Relevance:</strong> The FTS5 <code>bm25()</code> score.</li>
        <li><strong>Graph Relevance:</strong> The depth-decayed score from graph expansion.</li>
        <li><strong>Layer Boosts:</strong> Entities found in the current workspace get a <code>10x</code> score multiplier compared to global fallbacks.</li>
      </ul>
      <p>
        These signals are combined using a deterministic Reciprocal Rank Fusion (RRF) algorithm to ensure stable, predictable sorting across identical queries.
      </p>

      <h2>4. Compression</h2>
      <p>
        After sorting, ContextOS must fit the results into a strict token budget. It uses the <code>gpt-tokenizer</code> to measure exact token boundaries. We compress results at the AST-chunk level, aggressively stripping out irrelevant file sections.
      </p>
      <p>
        If a file exceeds the budget, only the matched functions/classes are included, while the rest of the file is dropped, protecting the LLM's context window.
      </p>

    </DocPage>
  );
}
