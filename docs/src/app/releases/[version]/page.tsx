import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";
import { CopyCommand } from "@/components/copy-command";
import { ReleaseHeroMetrics } from "@/components/release/hero-metrics";
import { TokenComparison } from "@/components/release/token-comparison";
import { IsolationDiagram } from "@/components/release/isolation-diagram";
import { ArchitectureDiff } from "@/components/release/architecture-diff";
import { PerformanceCharts } from "@/components/release/performance-charts";

export default function ReleasePage({ params }: { params: { version: string } }) {
  const isV070 = params.version === "v0.7.0";

  return (
    <div className="min-h-screen bg-black text-white font-sans selection:bg-white/20">
      
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-6 bg-black/80 backdrop-blur-md border-b border-neutral-900">
        <div className="flex items-center gap-3 font-mono font-bold text-lg tracking-tight">
          <Link href="/" className="flex items-center gap-3">
            <span className="text-white text-xl">{">_"}</span>
            <span className="text-white">ContextOS</span>
          </Link>
        </div>
        <nav className="flex items-center gap-6 text-sm font-mono text-neutral-400">
          <Link href="/" className="hover:text-white transition-colors">Home</Link>
          <Link href="/docs" className="hover:text-white transition-colors">Documentation</Link>
          <Link href="/releases" className="hover:text-white transition-colors">Releases</Link>
          <a href="https://github.com/siddharthakatiyar/ContextOS" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">GitHub ↗</a>
        </nav>
      </header>

      {/* Main Content */}
      <main className="pt-32 pb-24 px-8 max-w-5xl mx-auto flex flex-col">
        
        <Link href="/releases" className="inline-flex items-center gap-2 text-neutral-500 hover:text-white transition-colors text-sm font-mono mb-12 w-fit">
          <ArrowLeft className="w-4 h-4" /> Back to Releases
        </Link>

        {/* HERO SECTION */}
        <section className="flex flex-col gap-6">
          <div className="flex items-center gap-4">
            <h1 className="text-5xl md:text-7xl font-bold tracking-tight">ContextOS {params.version}</h1>
            <div className="hidden md:flex flex-col text-xs font-mono text-neutral-500 uppercase tracking-widest gap-1 border-l border-neutral-800 pl-4">
              <span>19 Jul 2026</span>
              <span className="text-red-500">Contains Breaking Changes</span>
            </div>
          </div>
          
          <p className="text-2xl text-neutral-300 max-w-3xl mt-4">
            A complete redesign of the retrieval engine reducing token usage by up to 90%.
          </p>

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mt-8">
            <CopyCommand command="npm install -g @siddharthakatiyar/contextos@latest" />
            <a href="https://github.com/siddharthakatiyar/ContextOS/releases" target="_blank" className="text-neutral-400 hover:text-white transition-colors font-mono text-sm underline underline-offset-4">
              View on GitHub ↗
            </a>
          </div>
        </section>

        <ReleaseHeroMetrics />

        {isV070 ? (
          <>
            {/* TOKEN OPTIMIZED RETRIEVAL */}
            <section className="flex flex-col gap-8 py-16">
              <h2 className="text-3xl font-bold tracking-tight">Token Optimized Retrieval</h2>
              <p className="text-lg text-neutral-400 max-w-2xl">
                Naive retrieval systems send entire files to the LLM. In v0.7.0, ContextOS parses files into AST chunks, follows import graphs, and ranks individual functions and types by intent.
              </p>
              <div className="mt-4">
                <TokenComparison />
              </div>
            </section>

            {/* PROJECT ISOLATION */}
            <section className="flex flex-col gap-8 py-16 border-t border-neutral-900">
              <h2 className="text-3xl font-bold tracking-tight">Independent Project Isolation</h2>
              <p className="text-lg text-neutral-400 max-w-2xl">
                We eliminated cross-contamination. Instead of a massive global vector database, ContextOS now compiles a dedicated <code className="bg-neutral-900 px-2 py-1 rounded text-white">.contextos</code> SQLite index per workspace.
              </p>
              <div className="mt-4">
                <IsolationDiagram />
              </div>
            </section>

            {/* PIPELINE ARCHITECTURE */}
            <section className="flex flex-col gap-8 py-16 border-t border-neutral-900">
              <h2 className="text-3xl font-bold tracking-tight">Pipeline Architecture Diff</h2>
              <p className="text-lg text-neutral-400 max-w-2xl">
                The core engine has been replaced. Vector search is now just one step in a multi-stage filtering pipeline combining BM25, semantic embeddings, graph expansion, and intent ranking.
              </p>
              <div className="mt-4">
                <ArchitectureDiff />
              </div>
            </section>

            {/* BENCHMARKS */}
            <section className="flex flex-col gap-8 py-16 border-t border-neutral-900">
              <h2 className="text-3xl font-bold tracking-tight">Performance Benchmarks</h2>
              <p className="text-lg text-neutral-400 max-w-2xl">
                Measurable improvements across the board compared to the v0.6.x hybrid search engine. Tested on the React.js codebase (10,000+ files).
              </p>
              <div className="mt-8 max-w-3xl">
                <PerformanceCharts />
              </div>
            </section>

            {/* BREAKING CHANGES */}
            <section className="flex flex-col gap-8 py-16 border-t border-red-900/30">
              <div className="flex items-center gap-3">
                <div className="w-3 h-3 rounded-full bg-red-500"></div>
                <h2 className="text-3xl font-bold tracking-tight text-red-500">Breaking Changes</h2>
              </div>
              <p className="text-lg text-neutral-400 max-w-2xl">
                Because v0.7.0 migrates from global vector storage to local SQLite indices, your existing v0.6.0 indices are no longer compatible.
              </p>
              
              <div className="bg-[#110505] border border-red-900/30 rounded-xl p-8 max-w-3xl flex flex-col gap-6">
                <h3 className="font-mono text-red-400">Migration Steps</h3>
                <div className="flex flex-col gap-2 font-mono text-sm">
                  <div className="flex gap-4">
                    <span className="text-neutral-500">1.</span>
                    <code className="text-red-200">contextos clean</code>
                    <span className="text-neutral-500 ml-auto hidden sm:block">Purges old global index</span>
                  </div>
                  <div className="flex gap-4">
                    <span className="text-neutral-500">2.</span>
                    <code className="text-red-200">contextos reindex</code>
                    <span className="text-neutral-500 ml-auto hidden sm:block">Builds new local .contextos DB</span>
                  </div>
                </div>
              </div>
            </section>
          </>
        ) : (
          <div className="py-32 text-center text-neutral-500 font-mono">
            Detailed release notes for {params.version} are not available.
          </div>
        )}

      </main>

      {/* Footer / Timeline */}
      <footer className="border-t border-neutral-900 py-16 px-8 text-sm font-mono">
        <div className="max-w-5xl mx-auto flex flex-col gap-8">
          <div className="text-neutral-500 uppercase tracking-widest">Previous Releases</div>
          <div className="flex gap-8">
            <Link href="/releases/v0.6.0" className="text-neutral-400 hover:text-white transition-colors">v0.6.0</Link>
            <Link href="/releases/v0.5.0" className="text-neutral-400 hover:text-white transition-colors">v0.5.0</Link>
            <Link href="/releases/v0.4.0" className="text-neutral-400 hover:text-white transition-colors">v0.4.0</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
