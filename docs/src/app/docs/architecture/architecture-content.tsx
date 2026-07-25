"use client";

import { DocPage } from "@/components/docs/doc-page";
import { SourceLink } from "@/components/docs/source-link";
import { motion } from "framer-motion";

export function ArchitectureContent() {
  return (
    <DocPage
      title="Architecture Overview"
      description="The end-to-end pipeline of ContextOS, from raw source files to compressed LLM prompts."
      prev={{ title: "Configuration", href: "/docs/reference/configuration" }}
      next={{ title: "Initialization Sequence", href: "/docs/initialization" }}
    >
      <SourceLink path="src/core/indexer/index.ts" />

      <h2>The Pipeline</h2>
      <p>
        ContextOS operates in two distinct phases: <strong>Compile-Time</strong> (indexing) and <strong>Runtime</strong> (retrieval). 
        The architecture ensures that all heavy computation—parsing, graph building, and embedding generation—happens asynchronously 
        during compilation, keeping runtime latencies strictly under 50ms.
      </p>

      <div className="my-12 p-8 bg-[#050505] border border-neutral-800 rounded-xl font-mono text-sm flex flex-col gap-2 relative overflow-hidden">
        
        <motion.div 
          initial={{ y: "0%" }}
          animate={{ y: "100%" }}
          transition={{ duration: 4, repeat: Infinity, ease: "linear" }}
          className="absolute top-0 bottom-0 left-12 w-px bg-gradient-to-b from-transparent via-neutral-500 to-transparent opacity-50 z-0"
        />

        <div className="z-10 flex flex-col gap-6">
          <div className="text-neutral-500 uppercase tracking-widest text-xs font-bold mb-2">Compile Phase</div>
          
          <div className="flex gap-4 items-center">
            <div className="w-8 h-8 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-xs">1</div>
            <div className="flex-1 bg-[#111] border border-neutral-800 p-4 rounded-lg">
              <span className="text-white font-bold">Repository Scanner</span> <span className="text-neutral-500">// Traverses workspace, dirty-checks hash</span>
            </div>
          </div>
          
          <div className="flex gap-4 items-center">
            <div className="w-8 h-8 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-xs">2</div>
            <div className="flex-1 bg-[#111] border border-neutral-800 p-4 rounded-lg">
              <span className="text-white font-bold">Tree-sitter Parser</span> <span className="text-neutral-500">// Generates AST, extracts symbols & chunks</span>
            </div>
          </div>

          <div className="flex gap-4 items-center">
            <div className="w-8 h-8 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-xs">3</div>
            <div className="flex-1 bg-[#111] border border-neutral-800 p-4 rounded-lg">
              <span className="text-white font-bold">Graph Builder</span> <span className="text-neutral-500">// Extracts internal symbol relations and file imports</span>
            </div>
          </div>

          <div className="flex gap-4 items-center">
            <div className="w-8 h-8 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-xs">4</div>
            <div className="flex-1 bg-[#111] border border-neutral-800 p-4 rounded-lg">
              <span className="text-white font-bold">Background Embedding</span> <span className="text-neutral-500">// Non-blocking generation of dense vectors</span>
            </div>
          </div>

          <div className="flex gap-4 items-center">
            <div className="w-8 h-8 rounded-full bg-[#110505] border border-red-900/30 text-red-500 flex items-center justify-center text-xs">5</div>
            <div className="flex-1 bg-[#110505] border border-red-900/30 p-4 rounded-lg">
              <span className="text-red-300 font-bold">SQLite Storage</span> <span className="text-red-900/50">// Atomic commit to local .contextos DB</span>
            </div>
          </div>

          <div className="text-neutral-500 uppercase tracking-widest text-xs font-bold mt-8 mb-2">Runtime Phase</div>

          <div className="flex gap-4 items-center">
            <div className="w-8 h-8 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-xs">6</div>
            <div className="flex-1 bg-[#111] border border-neutral-800 p-4 rounded-lg">
              <span className="text-white font-bold">RRF Hybrid Retriever</span> <span className="text-neutral-500">// BM25 + Vector Search + Intent Multipliers</span>
            </div>
          </div>

          <div className="flex gap-4 items-center">
            <div className="w-8 h-8 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-xs">7</div>
            <div className="flex-1 bg-[#111] border border-neutral-800 p-4 rounded-lg">
              <span className="text-white font-bold">Graph Expansion</span> <span className="text-neutral-500">// BFS traversal through dependency edges</span>
            </div>
          </div>

          <div className="flex gap-4 items-center">
            <div className="w-8 h-8 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center text-xs">8</div>
            <div className="flex-1 bg-[#111] border border-neutral-800 p-4 rounded-lg">
              <span className="text-white font-bold">Compression Engine</span> <span className="text-neutral-500">// Aggressive token reduction (stripping docs/imports)</span>
            </div>
          </div>
        </div>
      </div>

      <h2>Compile-Time Subsystems</h2>

      <h3>Parser (Tree-sitter) & Chunking</h3>
      <p>
        The parser converts raw string buffers into a structured AST. We use <code>tree-sitter</code> because it guarantees incremental 
        parsing and fault tolerance. During extraction, the AST is shredded into independent <code>Chunk</code> objects (representing functions, interfaces, or classes), retaining exact byte offsets and parent symbol mappings.
      </p>

      <h3>Graph Builder</h3>
      <p>
        Once chunks are generated, the system maps internal and external dependencies. <code>extractImportRelationships</code> walks the import statements, mapping logical connections between file stems. These generate <code>edges</code> with specific traversal weights.
      </p>

      <h3>SQLite Storage & Foreign Keys</h3>
      <p>
        ContextOS guarantees transactional integrity through SQLite's WAL mode and cascading foreign keys. If a file is deleted, <code>this.filesRepo.deleteByPath(filePath)</code> instantly purges all associated chunks, relationships, and embeddings via <code>ON DELETE CASCADE</code>. The entire schema is defined locally in <code>.contextos/index.db</code>, which means zero network latency.
      </p>

      <h3>Background Daemon & Concurrency</h3>
      <p>
        The <code>contextos serve</code> daemon manages all long-running indexing tasks without blocking the active developer workflow.
      </p>
      <ul className="flex flex-col gap-4 mt-4">
        <li className="flex gap-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-xs font-mono h-fit">pLimit</div>
          <div className="text-neutral-300">File watcher events are queued through a concurrency limiter (<code>pLimit(5)</code>). This provides crucial DOS protection during massive workspace changes (like a <code>git checkout</code> that touches thousands of files), preventing CPU starvation.</div>
        </li>
        <li className="flex gap-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-xs font-mono h-fit">Sandbox Guards</div>
          <div className="text-neutral-300">Strict path traversal guards ensure the Daemon never indexes files outside the approved workspace root, protecting sensitive system directories.</div>
        </li>
      </ul>

      <h2>Runtime Subsystems</h2>

      <h3>RRF Hybrid Retrieval</h3>
      <p>
        During a query, ContextOS does not rely solely on dense vectors. It runs a Reciprocal Rank Fusion (RRF) algorithm combining exact keyword matches from FTS5, semantic matches from the embedding store, and <code>feedback_signals</code> multipliers.
      </p>

      <h3>Compression Engine</h3>
      <p>
        After the graph expander collects the relevant nodes, the Compression Engine ensures the payload fits within the LLM's token budget. It utilizes hierarchical dropping—purging imports, docstrings, and low-priority chunks before it resorts to truncating business logic.
      </p>

    </DocPage>
  );
}
