import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { CopyCommand } from "@/components/copy-command";

export const metadata = {
  title: "Releases | ContextOS",
  description: "Changelog and release notes for ContextOS.",
};

const releases = [
  {
    version: "v0.7.0",
    date: "19 Jul 2026",
    type: "Major Release",
    description: "The largest architectural rewrite since ContextOS was created.",
    highlights: [
      "10× better token efficiency",
      "Zero cross contamination",
      "AST semantic chunking",
    ],
    link: "/releases/v0.7.0",
    active: true,
  },
  {
    version: "v0.6.0",
    date: "10 Jul 2026",
    type: "Minor Release",
    description: "Retrieval overhaul featuring Schema v5, RRF fusion, and local embeddings.",
    highlights: [
      "RRF fusion retrieval",
      "Query-aware compile",
      "Hardened MCP tools",
    ],
    link: "#",
    active: false,
  },
  {
    version: "v0.5.0",
    date: "10 Jul 2026",
    type: "Minor Release",
    description: "Major token optimization cutting E2E tokens under baseline.",
    highlights: [
      "Tiered compile",
      "Retrieval precision",
    ],
    link: "#",
    active: false,
  },
  {
    version: "v0.4.0",
    date: "07 Jul 2026",
    type: "Minor Release",
    description: "General robustness and security update.",
    highlights: [
      "Security patches",
      "Stability improvements",
    ],
    link: "#",
    active: false,
  },
  {
    version: "v0.3.0",
    date: "06 Jul 2026",
    type: "Minor Release",
    description: "Introduced cross-session memory and smart context assembly.",
    highlights: [
      "Cross-session memory",
      "Smart context assembly",
      "Graph visualization",
    ],
    link: "#",
    active: false,
  },
  {
    version: "v0.2.0",
    date: "09 Jun 2026",
    type: "Initial Release",
    description: "First public beta of ContextOS.",
    highlights: [
      "Basic file retrieval",
      "CLI interface",
    ],
    link: "#",
    active: false,
  }
];

export default function ReleasesPage() {
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
      <main className="pt-32 pb-24 px-8 max-w-4xl mx-auto flex flex-col gap-16">
        
        <header className="flex flex-col gap-4">
          <h1 className="text-4xl font-bold tracking-tight">Releases</h1>
          <p className="text-xl text-neutral-400 font-mono">
            Changelog and technical updates.
          </p>
          <div className="mt-4 w-fit">
            <CopyCommand command="npm i -g @siddharthakatiyar/contextos && contextos init" />
          </div>
        </header>

        <div className="flex flex-col gap-8 relative">
          {/* Timeline Line */}
          <div className="absolute left-0 top-2 bottom-0 w-px bg-neutral-900 ml-4 hidden md:block"></div>

          {releases.map((release) => (
            <div key={release.version} className="flex flex-col md:flex-row gap-6 md:gap-12 relative group">
              {/* Timeline Dot */}
              <div className="hidden md:flex absolute left-4 -translate-x-1/2 top-4 w-3 h-3 rounded-full border-2 border-black bg-neutral-700 group-hover:bg-white transition-colors z-10"></div>
              
              <div className="md:w-32 pt-2 md:pl-12 shrink-0">
                <div className="text-neutral-500 font-mono text-sm">{release.date}</div>
              </div>
              
              <div className={`flex-1 flex flex-col gap-4 border ${release.active ? 'border-neutral-700 bg-neutral-900/30' : 'border-neutral-900 bg-transparent'} p-6 rounded-lg transition-colors`}>
                <div className="flex items-center justify-between">
                  <h2 className="text-2xl font-bold">{release.version}</h2>
                  <span className="text-xs font-mono px-2 py-1 bg-neutral-800 text-neutral-300 rounded uppercase tracking-widest">{release.type}</span>
                </div>
                
                <p className="text-neutral-300 text-lg">
                  {release.description}
                </p>

                <ul className="flex flex-col gap-2 mt-2">
                  {release.highlights.map((highlight, idx) => (
                    <li key={idx} className="flex items-center gap-2 text-neutral-400 font-mono text-sm">
                      <span className="text-neutral-700">-</span> {highlight}
                    </li>
                  ))}
                </ul>

                {release.active && (
                  <div className="mt-4 pt-4 border-t border-neutral-800">
                    <Link href={release.link} className="inline-flex items-center gap-2 text-white font-semibold hover:text-neutral-300 transition-colors">
                      View Release <ArrowRight className="w-4 h-4" />
                    </Link>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

      </main>

      {/* Footer */}
      <footer className="border-t border-neutral-900 py-8 px-8 flex justify-between items-center text-sm font-mono text-neutral-600">
        <div>ContextOS © 2026</div>
        <div className="flex gap-4">
          <Link href="/" className="hover:text-white transition-colors">Home</Link>
          <Link href="#" className="hover:text-white transition-colors">Documentation</Link>
          <Link href="#" className="hover:text-white transition-colors">GitHub</Link>
        </div>
      </footer>
    </div>
  );
}
