import { DocPage } from "@/components/docs/doc-page";
import { buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "Design Decisions",
  description: "The rationale behind the core architectural choices in ContextOS.",
  path: "/docs/design-decisions",
});

export default function DesignDecisionsDocs() {
  return (
    <DocPage
      title="Design Decisions"
      description="The rationale behind the core architectural choices in ContextOS."
      prev={{ title: "Introduction", href: "/docs" }}
      next={{ title: "CLI Commands", href: "/docs/reference/cli" }}
    >
      <h2>Why SQLite? (Instead of a Vector Database)</h2>
      <p>
        Vector databases (Pinecone, Milvus, Chroma) are designed for global semantic search. They map words into high-dimensional space to find "conceptual" similarities.
      </p>
      <p>
        ContextOS is designed for exact syntactic resolution. If you query <code>DatabaseConnection</code>, you don't want "something conceptually similar to a database", you want the exact class definition. SQLite's <code>FTS5</code> (Full Text Search) provides instant, exact substring and token matching with zero overhead. Furthermore, SQLite is a single local file, requiring no Docker containers, no cloud accounts, and no network latency.
      </p>

      <h2>Why AST-based Chunking?</h2>
      <p>
        Most RAG (Retrieval-Augmented Generation) pipelines chunk text using naive sliding windows (e.g., every 500 words). In code, a sliding window might cut a function in half, stranding the return statement in chunk B while the parameters are in chunk A.
      </p>
      <p>
        ContextOS parses the raw code using <code>tree-sitter</code> into an Abstract Syntax Tree (AST). It chunks code exactly by its logical boundaries: classes, interfaces, and functions. This ensures the LLM receives syntactically valid blocks of code.
      </p>

      <h2>Why Project-Local Databases?</h2>
      <p>
        Global indexing tools dump all your repositories into a single massive index. If you have five different projects using a <code>User</code> class, asking an LLM to "fix the User authentication" will retrieve <code>User</code> files from all five projects, destroying the context window with irrelevant noise.
      </p>
      <p>
        ContextOS uses <code>.contextos/index.db</code> files stored directly inside each repository. When you query within a project, it heavily boosts (or exclusively restricts) results to that specific workspace layer, guaranteeing perfect isolation.
      </p>

      <h2>Why BM25 over Embeddings?</h2>
      <p>
        Embeddings suffer from the "Semantic Collision" problem in codebases. A <code>StripePaymentService</code> and a <code>PayPalPaymentService</code> embed very closely together because they share semantic concepts, but syntactically they share no code. 
      </p>
      <p>
        BM25 (using SQLite FTS5) ranks by term frequency. It guarantees that searching for <code>StripePaymentService</code> will return exactly that file, completely ignoring <code>PayPalPaymentService</code>. It is also completely local and requires no GPU inference.
      </p>

      <h2>Why MCP? (Model Context Protocol)</h2>
      <p>
        Instead of building a bespoke VSCode extension, a JetBrains plugin, and a standalone chat UI, ContextOS exposes its retrieval engine via the open Model Context Protocol. This allows it to natively hook into Claude Desktop, Cursor, and any future AI agents without requiring any custom UI development.
      </p>
    </DocPage>
  );
}
