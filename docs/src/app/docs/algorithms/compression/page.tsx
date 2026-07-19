import { DocPage } from "@/components/docs/doc-page";
import { SourceLink } from "@/components/docs/source-link";
import { ComplexityTable } from "@/components/docs/complexity-table";

export default function CompressionDocs() {
  return (
    <DocPage
      title="Context Compression"
      description="Algorithms to surgically slice AST chunks to fit strict LLM token budgets."
      prev={{ title: "Graph Expansion", href: "/docs/algorithms/graph-expansion" }}
      next={{ title: "SQLite Schema", href: "/docs/database/schema" }}
    >
      <SourceLink path="src/core/compiler/compiler.ts" />

      <h2>The Context Window Problem</h2>
      <p>
        If a user queries for the <code>validate()</code> method, standard vector DBs return the <i>entire file</i>. If that file is 3,000 lines long, it consumes 30k+ tokens instantly. 
      </p>
      <p>
        ContextOS compiles results at the AST node level, enforcing a hard <code>maxTokenBudget</code> (default: 40k). 
      </p>

      <h2>Token Budgeting Algorithm</h2>
      <p>
        ContextOS iterates over the ranked results and executes a greedy knapsack-style packing algorithm.
      </p>

      <ol>
        <li><strong>Group by File:</strong> We group top chunks by their source file. We do not inject chunks out of file order.</li>
        <li><strong>Calculate Framing Overhead:</strong> For each file, we calculate the tokens required for XML framing: <code>&lt;file path="..."&gt;...&lt;/file&gt;</code>.</li>
        <li><strong>Exact Token Measurement:</strong> We use the <code>gpt-tokenizer</code> package to physically count tokens on the fly.</li>
      </ol>

      <h2>Fallback Mechanisms</h2>
      <p>
        If the budget is exceeded mid-file, ContextOS triggers graceful degradation:
      </p>

      <pre>
        <code className="language-typescript">
{`if (currentTokenCount + chunkTokens > budget) {
  // Option 1: Try stripping comments
  const stripped = stripComments(chunk.body);
  if (count(stripped) <= budget) {
    return add(stripped);
  }

  // Option 2: Try truncating the body entirely, leaving just the signature
  const signature = extractSignature(chunk.body);
  if (count(signature) <= budget) {
    return add(signature + '\\n  // ... (body truncated)');
  }

  // Option 3: Drop the chunk entirely to preserve budget integrity
  return drop();
}`}
        </code>
      </pre>

      <ComplexityTable 
        time="O(C)" 
        space="O(C)" 
        averageCase="~15ms (bound by tokenizer)" 
        worstCase="~50ms"
      />

    </DocPage>
  );
}
