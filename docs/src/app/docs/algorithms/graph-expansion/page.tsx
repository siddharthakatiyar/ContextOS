import { DocPage } from "@/components/docs/doc-page";
import { SourceLink } from "@/components/docs/source-link";
import { ComplexityTable } from "@/components/docs/complexity-table";

export default function GraphExpansionDocs() {
  return (
    <DocPage
      title="Graph Expansion"
      description="The BFS algorithm responsible for traversing AST-derived dependency edges to construct the final LLM context."
      prev={{ title: "Initialization Sequence", href: "/docs/initialization" }}
      next={{ title: "SQLite Schema", href: "/docs/database/schema" }}
    >
      <SourceLink path="src/core/graph/expander.ts" />

      <h2>Problem Statement</h2>
      <p>
        When an LLM asks a question about <code>AuthenticationService</code>, a standard vector search will likely return the 
        file where <code>AuthenticationService</code> is defined. However, if that service relies heavily on a <code>TokenValidator</code> 
        class defined in another file, the LLM will fail to understand the complete logic because the token validator was never included in the context.
      </p>

      <h2>High-Level Explanation</h2>
      <p>
        Graph Expansion solves this by treating the codebase as a directed graph where files are nodes and imports are edges. 
        When a primary file is selected by the retriever, ContextOS immediately performs a Breadth-First Search (BFS) starting from that file, 
        traversing its outward edges to pull in its immediate dependencies.
      </p>

      <ComplexityTable 
        time="O(V + E)" 
        space="O(V)" 
        averageCase="~12ms for depth=2" 
        worstCase="~80ms for depth=4"
      />

      <h2>Entity Qualification</h2>
      <p>
        Before any node is pushed to the BFS queue, it must pass the <code>isQualityEntity</code> filter. We strictly drop natural language words, pure numbers, and anything under 3 characters to prevent graph explosions caused by generic variable names.
      </p>

      <pre>
        <code className="language-typescript">
{`const MIN_ENTITY_LENGTH = 3;

function isQualityEntity(entity: string): boolean {
  if (entity.length < MIN_ENTITY_LENGTH) return false;
  if (/^\\d+$/.test(entity)) return false;                  // pure number
  if (STOPWORDS.has(entity.toLowerCase())) return false;    // natural language word
  return true;
}`}
        </code>
      </pre>

      <h2>Detailed Algorithm (Implementation)</h2>
      
      <p>
        The expansion algorithm takes a set of seed nodes (the entities returned by the initial text/vector search) and an expansion depth limit <code>maxDepth</code> (default 2), alongside a hard limit of <code>maxNodes</code> (default 20).
      </p>

      <pre>
        <code className="language-typescript">
{`export class GraphExpander {
  public expand(seeds: string[], maxDepth: number = 2, maxNodes: number = 20): ExpandedEntity[] {
    const visited = new Set<string>();
    const queue: { entity: string; depth: number; weight: number; relType?: string }[] = [];
    
    // Priority Queue sorted by relationship weight
    const pushQueue = (item: { entity: string; depth: number; weight: number; relType?: string }) => {
      queue.push(item);
      queue.sort((a, b) => b.weight - a.weight);
    };
    
    const results: ExpandedEntity[] = [];

    // Only seed with quality entities
    for (const seed of seeds) {
      if (isQualityEntity(seed)) {
        pushQueue({ entity: seed, depth: 0, weight: 1.0 });
      }
    }

    while (queue.length > 0 && results.length < maxNodes) {
      const current = queue.shift()!;
      
      if (visited.has(current.entity) || current.depth > maxDepth) {
        continue;
      }
      visited.add(current.entity);

      if (current.depth > 0) {
        results.push({
          entity: current.entity,
          relationshipType: current.relType || 'expanded',
          depth: current.depth,
          // Score decays exponentially by depth
          score: current.weight * Math.pow(0.5, current.depth)
        });
      }

      for (const repo of this.relsRepos) {
        const directNeighbors = repo.findRelated(current.entity);

        // Hub detection: if this entity has too many connections, it's noise
        if (directNeighbors.length > 30 /* MAX_CONNECTIONS_THRESHOLD */) {
          continue;
        }

        for (const rel of directNeighbors) {
          // Weight threshold: only traverse meaningful edges
          if (rel.weight < 0.9 /* MIN_EDGE_WEIGHT */) continue;

          const neighbor = rel.source === current.entity ? rel.target : rel.source;
          if (!visited.has(neighbor) && isQualityEntity(neighbor)) {
            pushQueue({ 
              entity: neighbor, 
              depth: current.depth + 1, 
              weight: rel.weight,
              relType: rel.relationshipType
            });
          }
        }
      }
    }

    // Sort by depth ASC, score DESC
    results.sort((a, b) => {
      if (a.depth !== b.depth) return a.depth - b.depth;
      return b.score - a.score;
    });

    return results;
  }
}`}
        </code>
      </pre>

      <h2>Tradeoffs & Edge Cases</h2>
      
      <h3>Hub Detection & Rejection</h3>
      <p>
        Notice the <code>MAX_CONNECTIONS_THRESHOLD = 30</code> check. If an entity is imported by 100 different files (like a global <code>Logger</code> or <code>AppConfig</code>), traversing it during BFS will pollute the context window with dozens of irrelevant files. The Graph Expander detects these "God Objects" and intentionally terminates traversal through them.
      </p>

      <h3>Exponential Decay</h3>
      <p>
        The final score of a retrieved entity is calculated as: <code>current.weight * Math.pow(0.5, current.depth)</code>. This ensures that direct dependencies (Depth 1) are always strongly favored over distant transient dependencies (Depth 2+), keeping the LLM focused on immediate context.
      </p>

    </DocPage>
  );
}
