"use client";

import { DocPage } from "@/components/docs/doc-page";
import { SourceLink } from "@/components/docs/source-link";

export function BenchmarksContent() {
  return (
    <DocPage
      title="Benchmarks & Performance"
      description="Performance metrics, latency, and context compression benchmarks for ContextOS."
      prev={{ title: "Architecture", href: "/docs/architecture" }}
      next={{ title: "Algorithms", href: "/docs/algorithms/retrieval-pipeline" }}
    >
      <SourceLink path="tests/benchmarks" />

      <h2>Compression Benchmarks</h2>
      <p>
        ContextOS solves this by aggressively stripping out noise: omitting unchanged imports, stripping documentation strings, and extracting only the exact code blocks necessary to satisfy the query.
      </p>

      <div className="my-12 p-8 bg-[#050505] border border-neutral-800 rounded-xl overflow-hidden relative">
        <h3 className="text-xl font-bold mb-6 mt-0">Standard 100-Query Benchmark</h3>
        
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <div className="flex flex-col gap-2">
            <span className="text-neutral-500 font-mono text-sm uppercase tracking-widest">Average Tokens / Query</span>
            <div className="flex items-end gap-4">
              <span className="text-4xl font-bold text-white">589</span>
            </div>
            <p className="text-xs text-neutral-400 mt-2">Average token usage per query across the 100-query benchmark.</p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-neutral-500 font-mono text-sm uppercase tracking-widest">Retrieval Latency</span>
            <div className="flex items-end gap-4">
              <span className="text-4xl font-bold text-white">&lt; 50ms</span>
            </div>
            <p className="text-xs text-neutral-400 mt-2">P99 Latency for retrieving from local SQLite database (including BM25 and Vector matching).</p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-neutral-500 font-mono text-sm uppercase tracking-widest">Exact Function Accuracy</span>
            <div className="flex items-end gap-4">
              <span className="text-4xl font-bold text-green-400">98%</span>
            </div>
            <p className="text-xs text-neutral-400 mt-2">Successfully pinpointing the exact AST node (function/class) required to answer the query.</p>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-neutral-500 font-mono text-sm uppercase tracking-widest">Conceptual Accuracy</span>
            <div className="flex items-end gap-4">
              <span className="text-4xl font-bold text-blue-400">96%</span>
            </div>
            <p className="text-xs text-neutral-400 mt-2">Successfully mapping the semantic intent of the query to correct codebase domains.</p>
          </div>
        </div>
      </div>

      <h2>Throughput & Scalability</h2>
      
      <p>
        The backend Daemon handles indexing asynchronously. Rather than blocking your LLM queries, indexing happens passively in the background using SQLite WAL mode.
      </p>

      <ul className="flex flex-col gap-4 mt-6">
        <li className="flex gap-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-xs font-mono h-fit">1,000,000 files</div>
          <div className="text-neutral-300">Hard limit on total files parsed per workspace to prevent Out-Of-Memory (OOM) errors and sandbox escapes.</div>
        </li>
        <li className="flex gap-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-xs font-mono h-fit">~2ms / file</div>
          <div className="text-neutral-300">Average parsing time using the Tree-sitter AST parser, enabling rapid initial indexing.</div>
        </li>
        <li className="flex gap-4">
          <div className="bg-neutral-900 border border-neutral-800 rounded px-2 py-1 text-xs font-mono h-fit">pLimit(5)</div>
          <div className="text-neutral-300">Concurrency cap on file watchers, preventing CPU starvation during massive branch swaps (e.g., <code>git checkout</code>).</div>
        </li>
      </ul>

    </DocPage>
  );
}
