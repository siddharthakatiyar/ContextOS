import { DocPage } from "@/components/docs/doc-page";
import { SourceLink } from "@/components/docs/source-link";

export default function CliDocs() {
  return (
    <DocPage
      title="CLI Reference"
      description="Command-line interface commands for managing ContextOS in your repository."
      prev={{ title: "Introduction", href: "/docs" }}
      next={{ title: "Configuration", href: "/docs/reference/configuration" }}
    >
      <SourceLink path="src/index.ts" />

      <h2>Usage</h2>
      <p>
        The ContextOS binary is installed globally or invoked via <code>npx</code>. All commands are executed within the context of your current working directory (which is expected to be a Git repository).
      </p>
      <pre>
        <code className="language-bash">
{`npx contextos <command> [options]`}
        </code>
      </pre>

      <div className="border-t border-neutral-800 my-8"></div>

      <h2>Commands</h2>

      <h3><code>init</code></h3>
      <p>
        Initializes ContextOS in the current repository. This creates the local <code>.contextos</code> SQLite database, parses all supported files, generates AST chunks, extracts relationship edges, and computes embeddings (if configured).
      </p>
      <pre>
        <code className="language-bash">
{`contextos init`}
        </code>
      </pre>

      <h3><code>query</code></h3>
      <p>
        Execute a natural language search against the repository. This runs the RRF Hybrid Retriever and Graph Expansion engine to return the most contextually relevant codebase snippets.
      </p>
      <pre>
        <code className="language-bash">
{`contextos query "How is the authentication token validated?"`}
        </code>
      </pre>
      <h4>Options</h4>
      <ul className="list-none pl-0 space-y-2">
        <li><code>--raw</code>: Output raw JSON instead of human-readable text.</li>
        <li><code>--depth &lt;n&gt;</code>: Set the BFS graph expansion depth (default: 2).</li>
      </ul>

      <h3><code>watch</code></h3>
      <p>
        Starts a background filesystem watcher (using <code>chokidar</code>). When you save a file in your editor, the watcher instantly diffs the AST and surgically updates the SQLite graph. This allows the index to stay up-to-date with zero manual re-indexing.
      </p>
      <pre>
        <code className="language-bash">
{`contextos watch`}
        </code>
      </pre>

      <h3><code>daemon</code></h3>
      <p>
        Starts the ContextOS HTTP / JSON-RPC server on a local port. This daemon is used by IDE extensions (like Cursor or VSCode) to communicate with the retrieval engine over a persistent connection.
      </p>
      <pre>
        <code className="language-bash">
{`contextos daemon --port 4000`}
        </code>
      </pre>

      <h3><code>reindex</code></h3>
      <p>
        Forces a hard rebuild of the <code>.contextos</code> database. Useful if the database state becomes corrupted or if you change ignore patterns in <code>contextos.json</code>.
      </p>
      <pre>
        <code className="language-bash">
{`contextos reindex`}
        </code>
      </pre>

      <h3><code>status</code></h3>
      <p>
        Prints the current indexing metrics of the repository, including chunk counts, total relationship edges, and the SQLite database file size.
      </p>
      <pre>
        <code className="language-bash">
{`contextos status`}
        </code>
      </pre>

    </DocPage>
  );
}
