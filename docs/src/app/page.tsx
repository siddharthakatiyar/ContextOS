import { HeroTerminal } from '@/components/hero-terminal';
import { PipelineVisualizer } from '@/components/pipeline-visualizer';
import { SystemsDiagram } from '@/components/systems-diagram';
import { GraphDemo } from '@/components/graph-demo';
import { AnimatedMetrics } from '@/components/animated-metrics';
import { InstallTerminal } from '@/components/install-terminal';
import { CopyCommand } from '@/components/copy-command';
import { ArrowRight } from 'lucide-react';
import Link from 'next/link';
import Image from 'next/image';
import { buildMetadata, SITE_NAME, SITE_DESCRIPTION } from '@/lib/seo';

export const metadata = buildMetadata({
  title: `${SITE_NAME} - The Intelligent Retrieval Engine for AI Agents`,
  description: SITE_DESCRIPTION,
  path: '/'
});

export default function Home() {
  return (
    <div className="min-h-screen bg-black text-white font-sans selection:bg-white/20">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-6 bg-black/80 backdrop-blur-md border-b border-neutral-900">
        <div className="flex items-center gap-3 font-mono font-bold text-lg tracking-tight">
          <Link href="/" className="flex items-center gap-3">
            <span className="text-white text-xl">{'>_'}</span>
            <span className="text-white">ContextOS</span>
          </Link>
        </div>
        <nav className="flex items-center gap-6 text-sm font-mono text-neutral-400">
          <Link href="/" className="hover:text-white transition-colors">
            Home
          </Link>
          <Link href="/docs" className="hover:text-white transition-colors">
            Documentation
          </Link>
          <Link href="/releases" className="hover:text-white transition-colors">
            Releases
          </Link>
          <a
            href="https://siddhartha.work/blog"
            target="_blank"
            rel="noreferrer"
            className="hover:text-white transition-colors"
          >
            Blog ↗
          </a>
          <a
            href="https://github.com/siddharthakatiyar/ContextOS"
            target="_blank"
            rel="noreferrer"
            className="hover:text-white transition-colors"
          >
            GitHub ↗
          </a>
        </nav>
      </header>

      {/* Main Content */}
      <main className="pt-32 pb-24 px-8 max-w-6xl mx-auto flex flex-col gap-32">
        {/* HERO SECTION */}
        <section className="flex flex-col items-center text-center gap-12 mt-12">
          <div className="flex flex-col items-center gap-6 max-w-3xl">
            <div className="bg-neutral-900/50 border border-neutral-800 text-sm font-mono px-4 py-1.5 rounded-full inline-flex items-center gap-2 text-neutral-300 mb-2">
              <span className="flex h-2 w-2 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
              </span>
              v1.0.0 Stable is now available!
            </div>
            <h1 className="text-4xl md:text-6xl font-bold tracking-tight">ContextOS</h1>
            <p className="text-xl md:text-2xl text-neutral-400 font-mono">
              Memory infrastructure for AI agents.
            </p>
            <p className="text-lg text-neutral-500 max-w-2xl mx-auto">
              Give AI applications persistent, searchable, intent-aware context across millions of
              files without sending entire repositories to the LLM.
            </p>
          </div>

          <div className="w-full max-w-3xl">
            <HeroTerminal />
          </div>

          <div className="flex flex-col items-center gap-6 mt-4">
            <div className="flex items-center gap-4">
              <Link
                href="/docs"
                className="bg-white text-black px-6 py-3 font-semibold hover:bg-neutral-200 transition-colors flex items-center gap-2 rounded-md"
              >
                Documentation <ArrowRight className="w-4 h-4" />
              </Link>
              <a
                href="https://github.com/siddharthakatiyar/ContextOS"
                target="_blank"
                className="bg-neutral-900 border border-neutral-800 text-white px-6 py-3 font-semibold hover:bg-neutral-800 transition-colors rounded-md"
              >
                View on GitHub
              </a>
            </div>

            <CopyCommand command="npm i -g @siddharthakatiyar/contextos && contextos init" />
          </div>
        </section>

        {/* THE PROBLEM */}
        <section id="problem" className="flex flex-col gap-12 pt-12">
          <div className="flex flex-col gap-4">
            <h2 className="text-3xl font-bold tracking-tight">The Problem</h2>
            <p className="text-lg text-neutral-400 max-w-2xl">
              AI agents break when context windows overflow. ContextOS replaces naive file loading
              with an intelligent retrieval pipeline.
            </p>
          </div>
          <SystemsDiagram />
        </section>

        {/* SEE IT IN ACTION */}
        <section className="flex flex-col gap-8 pt-12">
          <div className="flex flex-col gap-4">
            <h2 className="text-3xl font-bold tracking-tight">See it in action</h2>
            <p className="text-lg text-neutral-400 max-w-2xl">
              A side-by-side comparison of an AI Agent answering a question about the repository.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold">Without ContextOS</h3>
                <span className="bg-red-900/50 text-red-400 text-xs font-mono px-3 py-1 rounded-full border border-red-800">
                  42K+ Tokens
                </span>
              </div>
              <p className="text-sm text-neutral-500 min-h-[40px]">
                Spawns expensive Explore subagents, blindly greps files, and suffers from massive
                context bloat.
              </p>
              <div className="border border-neutral-800 rounded-xl overflow-hidden bg-neutral-900 aspect-[16/10] relative">
                <Image
                  src="/without-contextos.gif"
                  alt="AI Agent without ContextOS"
                  fill
                  unoptimized
                  sizes="(min-width: 768px) 50vw, 100vw"
                  className="object-cover object-left-top"
                />
              </div>
            </div>

            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold">With ContextOS</h3>
                <span className="bg-green-900/50 text-green-400 text-xs font-mono px-3 py-1 rounded-full border border-green-800">
                  293 Tokens
                </span>
              </div>
              <p className="text-sm text-neutral-500 min-h-[40px]">
                Instant semantic retrieval, pinpoint accuracy, and minimal context usage in a single
                tool call.
              </p>
              <div className="border border-neutral-800 rounded-xl overflow-hidden bg-neutral-900 aspect-[16/10] relative">
                <Image
                  src="/query-where.gif"
                  alt="AI Agent with ContextOS"
                  fill
                  unoptimized
                  sizes="(min-width: 768px) 50vw, 100vw"
                  className="object-cover object-left-top"
                />
              </div>
            </div>
          </div>
        </section>

        {/* THE PIPELINE */}
        <section id="pipeline" className="flex flex-col gap-12 pt-12">
          <div className="flex flex-col gap-4">
            <h2 className="text-3xl font-bold tracking-tight">Retrieval Pipeline</h2>
            <p className="text-lg text-neutral-400 max-w-2xl">
              Watch how a repository transforms into a surgical context package.
            </p>
          </div>
          <PipelineVisualizer />
        </section>

        {/* GRAPH EXPANSION */}
        <section id="graph" className="flex flex-col gap-12 pt-12">
          <div className="flex flex-col gap-4">
            <h2 className="text-3xl font-bold tracking-tight">Graph Expansion</h2>
            <p className="text-lg text-neutral-400 max-w-2xl">
              Search finds keywords. Graph Expansion finds reality. Watch how ContextOS
              automatically pulls in related dependencies to build a complete context package.
            </p>
          </div>
          <GraphDemo />
        </section>

        {/* ENGINEERING BENCHMARKS */}
        <section className="flex flex-col gap-12 pt-24 pb-12 border-t border-neutral-900">
          <AnimatedMetrics />
        </section>

        {/* INSTALLATION */}
        <section className="flex flex-col items-center text-center gap-12 py-32 border-t border-neutral-900">
          <div className="flex flex-col gap-4 items-center">
            <h2 className="text-3xl font-bold tracking-tight">Ready to build?</h2>
            <p className="text-neutral-400">
              macOS / Linux / Windows • Zero configuration required
            </p>
          </div>

          <div className="w-full">
            <InstallTerminal />
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-neutral-900 py-8 px-8 flex justify-between items-center text-sm font-mono text-neutral-600">
        <div>ContextOS © 2026</div>
        <div className="flex gap-4">
          <Link href="/docs" className="hover:text-white transition-colors">
            Documentation
          </Link>
          <Link href="/releases" className="hover:text-white transition-colors">
            Releases
          </Link>
          <a
            href="https://siddhartha.work/blog"
            target="_blank"
            rel="noreferrer"
            className="hover:text-white transition-colors"
          >
            Blog ↗
          </a>
          <Link
            href="https://github.com/siddharthakatiyar/ContextOS"
            className="hover:text-white transition-colors"
          >
            GitHub
          </Link>
        </div>
      </footer>
    </div>
  );
}
