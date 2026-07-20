import { DocPage } from "@/components/docs/doc-page";
import { buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "Troubleshooting & FAQ",
  description: "Common issues, error codes, and how to resolve them.",
  path: "/docs/troubleshooting",
});

export default function TroubleshootingDocs() {
  return (
    <DocPage
      title="Troubleshooting & FAQ"
      description="Common issues, error codes, and how to resolve them."
      prev={{ title: "Framework Examples", href: "/docs/examples" }}
    >
      <h2>Daemon Connection Drops (EPERM / ENOENT)</h2>
      <p>
        If the ContextOS MCP client fails to connect to the daemon with an <code>EPERM</code> or <code>ENOENT</code> error on the socket path, it usually means the background daemon process crashed and left a stale socket file or PID lock.
      </p>
      <p>
        <strong>Resolution:</strong> ContextOS is designed to auto-heal from these states. You can force a full restart by running:
      </p>
      <pre><code>npx contextos clean</code></pre>
      <p>
        This will shut down the daemon, delete the stale sockets, and clear the local index.
      </p>

      <h2>Database Corruption</h2>
      <p>
        SQLite is extremely robust, but if your machine forcefully crashes during an active indexing write, the <code>.contextos/index.db</code> file can corrupt.
      </p>
      <p>
        <strong>Resolution:</strong> Do nothing. ContextOS automatically runs a <code>PRAGMA quick_check</code> every time it boots. If it detects corruption, it silently deletes the broken DB and rebuilds it from scratch. Since ContextOS is just an index of your local files, no data is actually lost.
      </p>

      <h2>Ignoring Large or Generated Files</h2>
      <p>
        If ContextOS is indexing massive auto-generated files (like <code>package-lock.json</code> or compiled output) and wasting CPU cycles, you can add them to an ignore list.
      </p>
      <p>
        <strong>Resolution:</strong> ContextOS respects your <code>.gitignore</code> automatically. If you want to ignore files specifically for ContextOS (but commit them to git), create a <code>.contextosignore</code> file in the root of your project:
      </p>
      <pre>
        <code className="language-bash">
{`# .contextosignore
dist/
build/
docs/out/
*.min.js`}
        </code>
      </pre>

      <h2>Slow Indexing Performance</h2>
      <p>
        If indexing is taking unusually long, ensure you are running Node.js 18+. ContextOS relies on modern native crypto hashing and worker threads. If you are indexing a mono-repo with millions of lines of code, the initial pass may take a minute, but subsequent incremental index runs will be sub-second as it only hashes and updates modified files.
      </p>
    </DocPage>
  );
}
