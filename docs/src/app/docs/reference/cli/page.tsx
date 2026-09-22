import { DocPage } from "@/components/docs/doc-page";
import { SourceLink } from "@/components/docs/source-link";
import { buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "CLI Reference",
  description: "Command-line interface commands for managing ContextOS in your repository.",
  path: "/docs/reference/cli",
});

export default function CliDocs() {
  return (
    <DocPage
      title="CLI Reference"
      description="Command-line interface commands for managing ContextOS in your repository."
      prev={{ title: "Design Decisions", href: "/docs/design-decisions" }}
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
        Initializes ContextOS in the current repository, creates the local <code>.contextos</code> state directory, writes missing MCP configuration entries, and schedules indexing in the background. The command returns before a large repository has necessarily finished indexing; use <code>contextos status</code> to check readiness.
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
        <li><code>--json</code>: Output a machine-readable object containing intent, chunks, compiled context, and token count.</li>
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
        Manages the per-project background daemon. MCP clients normally launch <code>serve</code>, which connects to this daemon over a private local socket; the daemon does not expose an HTTP port.
      </p>
      <pre>
        <code className="language-bash">
{`contextos daemon start
contextos daemon status
contextos daemon stop`}
        </code>
      </pre>

      <h3><code>reindex</code></h3>
      <p>
        Stops the project daemon, deletes the local database and its SQLite sidecars, and invokes initialization again. Use this after changing ignore rules or when you need a clean index. Back up manual knowledge first because rebuilding removes database-resident facts, feedback, and session history.
      </p>
      <div className="bg-blue-50/50 border border-blue-100 rounded-lg p-4 my-6 dark:bg-blue-900/20 dark:border-blue-800">
        <p className="text-sm text-blue-800 dark:text-blue-300 m-0 leading-relaxed">
          <strong className="font-semibold">Note:</strong> Normal upgrades can schedule a background rebuild when the index format changes. Explicit reindexing is for a deliberate clean rebuild, and <code>contextos reindex --embeddings</code> backfills vectors without wiping an existing database.
        </p>
      </div>
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

      <h3><code>serve</code></h3>
      <p>
        Runs the MCP stdio bridge used by an AI client. It reads and writes JSON-RPC on standard streams and connects to the project daemon; run it manually only when integrating a client that starts commands itself.
      </p>
      <pre>
        <code className="language-bash">
{`contextos serve`}
        </code>
      </pre>

      <h3><code>clean</code></h3>
      <p>
        Removes indexed junk paths such as build output and <code>node_modules</code> from the local and resolved global databases. It does not stop the daemon or rebuild the index. Pass <code>--rebuild</code> for the destructive local database reset, and <code>--global</code> to include the shared global database.
      </p>
      <pre>
        <code className="language-bash">
{`contextos clean
contextos clean --rebuild
contextos clean --global`}
        </code>
      </pre>

    </DocPage>
  );
}
