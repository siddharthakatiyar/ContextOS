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
        <strong>Resolution:</strong> Check the daemon first, then stop and restart it if needed:
      </p>
      <pre><code>{`npx contextos daemon status
npx contextos daemon stop
npx contextos daemon start`}</code></pre>
      <p>
        <code>clean</code> removes indexed junk and does not stop the daemon or clear the whole index. Use <code>clean --rebuild</code> only when you intend to delete the local database; back up manual knowledge first.
      </p>

      <h2>Database Corruption</h2>
      <p>
        SQLite is extremely robust, but if your machine forcefully crashes during an active indexing write, the <code>.contextos/index.db</code> file can corrupt.
      </p>
      <p>
        <strong>Resolution:</strong> ContextOS runs <code>PRAGMA quick_check</code> at startup. A corrupt repository database may be rebuilt automatically when no live daemon is using it, but this removes database-resident facts, feedback, and session history. Stop the project daemon and copy <code>.contextos/index.db</code> together with its <code>-wal</code> and <code>-shm</code> sidecars before recovery. The shared <code>~/.contextos/index.db</code> is never destructively recovered while another project daemon might have it open; stop all relevant daemons, back it up, then remove and rebuild it deliberately.
      </p>

      <h2>Ignoring Large or Generated Files</h2>
      <p>
        If ContextOS is indexing massive auto-generated files (like <code>package-lock.json</code> or compiled output) and wasting CPU cycles, you can add them to an ignore list.
      </p>
      <p>
        <strong>Resolution:</strong> ContextOS applies configured ignore patterns and the repository&apos;s <code>.gitignore</code> / <code>.contextosignore</code> rules during indexing and watching. If you want to ignore files specifically for ContextOS (but commit them to git), create a <code>.contextosignore</code> file in the root of your project:
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
        If indexing is taking unusually long, ensure you are running Node.js 22.12.0 or later. ContextOS relies on modern native crypto hashing and worker threads. If you are indexing a mono-repo with millions of lines of code, the initial pass may take a minute, but subsequent incremental index runs will be sub-second as it only hashes and updates modified files.
      </p>

      <h2>CPU-only installation on Linux x64</h2>
      <p>
        The <code>onnxruntime-node</code> package can attempt to fetch optional CUDA
        provider files during installation on Linux x64. ContextOS can use its
        bundled CPU runtime, so skip that optional download on a CPU-only host:
      </p>
      <pre><code>{`ONNXRUNTIME_NODE_INSTALL=skip npm install -g @siddharthakatiyar/contextos`}</code></pre>
      <p>
        This is an install-time provider choice. It does not download or disable
        the local embedding model, and it should be omitted when CUDA execution is
        required. If a normal install fails while writing its temporary download,
        check the available space or quota for the system temporary directory.
      </p>
    </DocPage>
  );
}
