'use client';

import { DocPage } from '@/components/docs/doc-page';
import { SourceLink } from '@/components/docs/source-link';
import { CheckCircle2 } from 'lucide-react';

export function RoadmapContent() {
  return (
    <DocPage
      title="Roadmap"
      description="The high-level roadmap and future direction of ContextOS following the v1.0 stable release."
      prev={{ title: 'Benchmarks', href: '/docs/benchmarks' }}
      next={{ title: 'Retrieval Pipeline', href: '/docs/algorithms/retrieval-pipeline' }}
    >
      <SourceLink path="ROADMAP.md" />

      <p className="mb-8">
        This document outlines the high-level roadmap and future direction of ContextOS following
        the v1.0.0 stable release. This is a living document and may change based on community
        feedback and emerging use cases.
      </p>

      <div className="flex flex-col gap-12">
        {/* v1.0 */}
        <div className="flex flex-col gap-6">
          <div>
            <h2 className="text-2xl font-bold tracking-tight m-0">
              v1.0 (The &quot;Stable&quot; Release) ✅
            </h2>
            <div className="text-sm font-mono text-green-600 mt-2 uppercase tracking-widest">
              Released: August 4, 2026
            </div>
          </div>
          <p className="text-neutral-400">
            The goal for v1.0 is to ensure ContextOS is a tool you can depend on daily in your
            development workflow without worrying about database corruption, hanging daemons, or
            index desyncs.
          </p>

          <ul className="flex flex-col gap-4 mt-2 bg-[#050505] border border-neutral-900 rounded-lg p-6">
            <li className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
              <div className="flex flex-col">
                <span className="font-bold text-white">Zero-dependency architecture</span>
                <span className="text-neutral-500 text-sm">
                  Moved away from Redis/Qdrant to SQLite
                </span>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
              <div className="flex flex-col">
                <span className="font-bold text-white">Non-blocking Indexing</span>
                <span className="text-neutral-500 text-sm">
                  Background Daemon handles massive repos seamlessly
                </span>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
              <div className="flex flex-col">
                <span className="font-bold text-white">Semantic Chunking</span>
                <span className="text-neutral-500 text-sm">Tree-sitter AST integration</span>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
              <div className="flex flex-col">
                <span className="font-bold text-white">CI/CD & Observability</span>
                <span className="text-neutral-500 text-sm">
                  Automated linting, formatting, tests, and CLI tracing
                </span>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
              <div className="flex flex-col">
                <span className="font-bold text-white">Cross-Language AST Completeness</span>
                <span className="text-neutral-500 text-sm">
                  TSX parser supports JS/JSX/Flow; all major languages parse reliably
                </span>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0 mt-0.5" />
              <div className="flex flex-col">
                <span className="font-bold text-white">Comprehensive Documentation</span>
                <span className="text-neutral-500 text-sm">
                  Full CLI reference, architecture overview, and algorithm docs
                </span>
              </div>
            </li>
          </ul>
        </div>

        {/* v1.x */}
        <div className="flex flex-col gap-6 relative">
          <div className="absolute left-[-2rem] top-0 bottom-0 w-px bg-neutral-900 hidden md:block" />

          <div>
            <h2 className="text-2xl font-bold tracking-tight m-0 text-neutral-300">
              v1.x (Post-Launch Hardening)
            </h2>
          </div>

          <ul className="flex flex-col gap-4 bg-black border border-neutral-900 rounded-lg p-6">
            <li className="flex items-start gap-3">
              <div className="w-1.5 h-1.5 rounded-full bg-neutral-700 shrink-0 mt-2" />
              <div className="flex flex-col">
                <span className="font-bold text-neutral-300">Vector Search Optimization</span>
                <span className="text-neutral-500 text-sm">
                  Refining our local embeddings fallback and evaluating alternative, faster
                  on-device models.
                </span>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <div className="w-1.5 h-1.5 rounded-full bg-neutral-700 shrink-0 mt-2" />
              <div className="flex flex-col">
                <span className="font-bold text-neutral-300">Enhanced MCP Tools</span>
                <span className="text-neutral-500 text-sm">
                  Exposing more granular graph-traversal capabilities to connected LLMs via the
                  Model Context Protocol.
                </span>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <div className="w-1.5 h-1.5 rounded-full bg-neutral-700 shrink-0 mt-2" />
              <div className="flex flex-col">
                <span className="font-bold text-neutral-300">Windows Support</span>
                <span className="text-neutral-500 text-sm">
                  Ensuring native Windows path handling and daemon stability.
                </span>
              </div>
            </li>
          </ul>
        </div>

        {/* Long-term */}
        <div className="flex flex-col gap-6 relative">
          <div className="absolute left-[-2rem] top-0 bottom-0 w-px bg-neutral-900 hidden md:block" />

          <div>
            <h2 className="text-2xl font-bold tracking-tight m-0 text-neutral-400">
              Long-term Vision (v2.0+)
            </h2>
          </div>

          <ul className="flex flex-col gap-4 bg-black border border-neutral-900 rounded-lg p-6">
            <li className="flex items-start gap-3">
              <div className="w-1.5 h-1.5 rounded-full bg-neutral-700 shrink-0 mt-2" />
              <div className="flex flex-col">
                <span className="font-bold text-neutral-400">Distributed Project Knowledge</span>
                <span className="text-neutral-600 text-sm">
                  Securely sharing project metadata across developer teams.
                </span>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <div className="w-1.5 h-1.5 rounded-full bg-neutral-700 shrink-0 mt-2" />
              <div className="flex flex-col">
                <span className="font-bold text-neutral-400">Predictive Prefetching</span>
                <span className="text-neutral-600 text-sm">
                  Watching developer cursor movements to preemptively assemble context before an LLM
                  query is even fired.
                </span>
              </div>
            </li>
            <li className="flex items-start gap-3">
              <div className="w-1.5 h-1.5 rounded-full bg-neutral-700 shrink-0 mt-2" />
              <div className="flex flex-col">
                <span className="font-bold text-neutral-400">LSP Integration</span>
                <span className="text-neutral-600 text-sm">
                  Bringing ContextOS directly into IDE hover states.
                </span>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </DocPage>
  );
}
