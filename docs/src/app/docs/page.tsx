import { DocPage } from "@/components/docs/doc-page";
import { SourceLink } from "@/components/docs/source-link";
import { buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "Documentation",
  description: "The definitive technical specification for the ContextOS retrieval engine.",
  path: "/docs",
});

export default function DocsIntro() {
  return (
    <DocPage
      title="ContextOS"
      description="The definitive technical specification for the ContextOS retrieval engine."
      next={{ title: "Design Decisions", href: "/docs/design-decisions" }}
    >
      <SourceLink path="src/index.ts" />

      <h2>What is ContextOS?</h2>
      <p>
        ContextOS is a specialized semantic search and retrieval engine designed entirely around the constraints of Large Language Models. 
        Unlike general-purpose vector databases which return complete documents based on coordinate proximity, ContextOS parses 
        the source code into Abstract Syntax Trees, maps the dependency graph, and extracts only the relevant tokens required to 
        solve a specific intent.
      </p>

      <h2>Design Philosophy</h2>
      <p>
        Most retrieval pipelines follow a naive approach: <code>glob("**/*.ts") &rarr; Chunk &rarr; Embed &rarr; Cosine Search</code>.
        This leads to massive cross-contamination in the LLM's context window because the embeddings capture syntactic similarities 
        rather than logical dependencies.
      </p>
      
      <p>
        ContextOS was built on three core tenets:
      </p>
      <ul>
        <li>
          <strong>Syntactic awareness over semantic guessing.</strong> If a function depends on an interface, the system shouldn't guess if they are related. It should read the AST and know for a fact.
        </li>
        <li>
          <strong>Aggressive token compression.</strong> Returning 10 files of 500 lines each instantly destroys context windows. ContextOS isolates only the active symbols (functions, types, classes) and discards the rest of the file.
        </li>
        <li>
          <strong>Project Isolation.</strong> Global vector databases contaminate searches across workspaces. ContextOS uses isolated, project-local SQLite databases (<code>.contextos</code>) that live directly in the repository.
        </li>
      </ul>

      <h2>Mental Model</h2>
      <p>
        Think of ContextOS not as a database, but as a compiler.
      </p>
      <p>
        When you run <code>contextos init</code>, it does not just dump text into an embedding model. It runs a multi-pass compilation step:
      </p>
      <ol>
        <li>It reads the raw files.</li>
        <li>It parses them into an AST (Abstract Syntax Tree).</li>
        <li>It extracts specific symbols (e.g., the <code>UserAuth</code> class).</li>
        <li>It builds a graph of imports and dependencies (e.g., <code>UserAuth</code> depends on <code>SessionToken</code>).</li>
        <li>It compiles this graph into a localized SQLite file optimized for FTS5 (Full Text Search) and graph traversal.</li>
      </ol>
      <p>
        When you query the engine, you are traversing this compiled graph to package the minimum possible token payload.
      </p>
      
    </DocPage>
  );
}
