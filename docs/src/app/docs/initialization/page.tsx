import { DocPage } from "@/components/docs/doc-page";
import { SourceLink } from "@/components/docs/source-link";
import { ComplexityTable } from "@/components/docs/complexity-table";
import { buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "Initialization Sequence",
  description: "The end-to-end process executed by the 'contextos init' command, powered by the core Indexer.",
  path: "/docs/initialization",
});

export default function InitializationDocs() {
  return (
    <DocPage
      title="Initialization Sequence"
      description="The end-to-end process executed by the 'contextos init' command, powered by the core Indexer."
      prev={{ title: "Architecture", href: "/docs/architecture" }}
      next={{ title: "Retrieval Pipeline", href: "/docs/algorithms/retrieval-pipeline" }}
    >
      <SourceLink path="src/cli/commands/init.ts" />

      <h2>Purpose</h2>
      <p>
        The <code>contextos init</code> command is the entrypoint to the system. It delegates immediately to the <code>Indexer</code> class, which is responsible for scanning the repository, 
        parsing all source code into an AST, chunking it, building the dependency graph, generating embeddings, and seeding the local 
        SQLite database. It effectively acts as the "compiler" phase of ContextOS.
      </p>

      <h2>The Indexer Pipeline</h2>
      
      <p>The core logic lives inside <code>src/core/indexer/index.ts</code>. For every file discovered in the workspace, the <code>indexFile</code> method is invoked.</p>

      <h3>1. Validation & Safety Caps</h3>
      <p>
        Before any file is read into memory, we execute safety checks. We immediately skip files larger than 2MB (<code>MAX_FILE_BYTES</code>) or binary files (detected via null bytes) to prevent catastrophic OOM crashes during AST parsing.
      </p>
      <pre>
        <code className="language-typescript">
{`const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB

// Cap file size before read
if (stat.size > MAX_FILE_BYTES) return emptyStats;

// Check for binary
if (content.indexOf('\\0') !== -1) return emptyStats;`}
        </code>
      </pre>

      <h3>2. Dirty Checking</h3>
      <p>
        ContextOS only compiles what has changed. We hash the file buffer and check it against the <code>filesRepo</code>.
      </p>
      <pre>
        <code className="language-typescript">
{`const hash = hashContent(content);
if (!this.filesRepo.isChanged(filePath, hash)) {
  return emptyStats;
}`}
        </code>
      </pre>

      <h3>3. AST Generation & Chunking</h3>
      <p>
        The file extension routes the buffer to the appropriate tree-sitter parser (Code, Config, or Markdown). The AST is then walked to extract independent chunks and imports.
      </p>
      <pre>
        <code className="language-typescript">
{`if (isCode) {
  const parsed = await parseCode(filePath, content);
  imports = parsed.imports || [];
  chunks = chunkCode(parsed, { layer, workspaceName });
}`}
        </code>
      </pre>

      <h3>4. Database Transaction</h3>
      <p>
        All state updates run in a highly-optimized SQLite transaction to preserve foreign keys. If a file changed, we first execute an <code>ON DELETE CASCADE</code> purge of its old chunks and relationships, then bulk insert the new ones.
      </p>
      <pre>
        <code className="language-typescript">
{`// Update file record first for FK constraints
this.filesRepo.upsert({ path: filePath, hash, ... });

// Cleanup old chunks (cascades to relationships)
this.chunksRepo.deleteBySource(filePath);

// Bulk insert new chunks
this.chunksRepo.bulkUpsert(chunks);`}
        </code>
      </pre>

      <h3>5. Graph Edges & Non-Blocking Embeddings</h3>
      <p>
        Embeddings generation is the slowest part of the pipeline. To ensure <code>init</code> remains fast, embedding generation is strictly non-blocking. If the model fails or times out, the pipeline continues, as ContextOS falls back seamlessly to BM25 FTS5.
      </p>
      <pre>
        <code className="language-typescript">
{`try {
  await indexChunkEmbeddings(this.chunksRepo.getDatabase(), chunks);
} catch {
  // continue without embeddings
}

// Extract and bulk insert graph edges
const allRels = chunks.flatMap(c => extractRelationships(c));
this.relsRepo.bulkUpsert(allRels);`}
        </code>
      </pre>

      <ComplexityTable 
        time="O(F * S)" 
        space="O(S)" 
        averageCase="~4 seconds for 2k files" 
        worstCase="~45 seconds for 20k files"
      />
      <p className="text-xs text-neutral-500 mt-2">Where F = number of files, and S = average size of files in bytes.</p>

      <h2>Failure Modes</h2>
      <ul>
        <li>
          <strong>OOM (Out of Memory):</strong> Highly unlikely due to the hard <code>MAX_FILE_BYTES</code> cutoff, but an extremely complex 1.9MB TypeScript file could theoretically cause the tree-sitter WASM heap to panic.
        </li>
        <li>
          <strong>Corrupted SQLite state:</strong> Impossible. If the process is hard-killed (SIGKILL) mid-transaction, SQLite's WAL handles recovery on the next boot.
        </li>
      </ul>

    </DocPage>
  );
}
