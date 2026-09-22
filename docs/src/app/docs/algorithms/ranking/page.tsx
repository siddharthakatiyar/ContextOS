import { DocPage } from "@/components/docs/doc-page";
import { SourceLink } from "@/components/docs/source-link";
import { ComplexityTable } from "@/components/docs/complexity-table";
import { buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "Ranking & Tie-Breaking",
  description: "Deterministic scoring and Reciprocal Rank Fusion implementation.",
  path: "/docs/algorithms/ranking",
});

export default function RankingDocs() {
  return (
    <DocPage
      title="Ranking & Tie-Breaking"
      description="Deterministic scoring and Reciprocal Rank Fusion implementation."
      prev={{ title: "Retrieval Pipeline", href: "/docs/algorithms/retrieval-pipeline" }}
      next={{ title: "Graph Expansion", href: "/docs/algorithms/graph-expansion" }}
    >
      <SourceLink path="src/core/retrieval/scorer.ts" />

      <h2>Reciprocal Rank Fusion (RRF)</h2>
      <p>
        Because ContextOS merges signals from distinct algorithms (FTS5 BM25 vs BFS Graph Expansion), their raw scores cannot be directly compared. FTS5 produces unbounded negative floats, while BFS produces exponential decay vectors.
      </p>
      <p>
        We normalize these signals using Reciprocal Rank Fusion:
      </p>

      <pre>
        <code className="language-typescript">
{`const K = 60;
function rrfScore(rank: number): number {
  return 1 / (K + rank);
}`}
        </code>
      </pre>

      <h2>The Determinism Problem</h2>
      <p>
        ContextOS adds an explicit identifier tie-breaker when scores are equal, so output ordering does not depend on incidental input order. This keeps repeated queries stable across multi-turn chats.
      </p>
      <p>
        ContextOS enforces strict determinism via a stable tie-breaker:
      </p>

      <pre>
        <code className="language-typescript">
{`results.sort((a, b) => {
  if (Math.abs(a.score - b.score) > 1e-9) {
    return b.score - a.score;
  }
  // Deterministic tie-breaker
  return a.id.localeCompare(b.id);
});`}
        </code>
      </pre>

      <ComplexityTable 
        time="O(N log N)" 
        space="O(N)" 
        averageCase="< 1ms" 
        worstCase="< 5ms"
      />

      <h2>Heuristic Boosts</h2>
      <p>
        Scores are aggressively modified by deterministic heuristics:
      </p>
      <ul>
        <li><strong>Layer Promotion:</strong> Session, repository, workspace, and global layers use the configured multipliers; the default workspace multiplier is <code>1.1x</code>.</li>
        <li><strong>Intent Detection:</strong> Intent signals affect matching and query terms. There is no separate default AST type multiplier.</li>
        <li><strong>File Extensions:</strong> Binary and unreadable files are hard-capped at <code>score = 0</code>.</li>
      </ul>

    </DocPage>
  );
}
