import Link from "next/link";
import { ArrowLeft } from "lucide-react";

export const metadata = {
  title: "Documentation | ContextOS",
  description: "Official technical specification of the ContextOS retrieval engine.",
};

const navGroups = [
  {
    title: "Overview",
    links: [
      { title: "Introduction", href: "/docs" },
    ]
  },
  {
    title: "Reference",
    links: [
      { title: "CLI Commands", href: "/docs/reference/cli" },
      { title: "Configuration", href: "/docs/reference/configuration" },
    ]
  },
  {
    title: "System Design",
    links: [
      { title: "Architecture", href: "/docs/architecture" },
      { title: "Initialization Sequence", href: "/docs/initialization" },
    ]
  },
  {
    title: "Algorithms",
    links: [
      { title: "Graph Expansion", href: "/docs/algorithms/graph-expansion" },
    ]
  },
  {
    title: "Database",
    links: [
      { title: "SQLite Schema", href: "/docs/database/schema" },
    ]
  }
];

export default function DocsLayout({ children }: { children: React.ReactNode }) {
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

      {/* Main Container */}
      <div className="pt-20 flex w-full max-w-[1400px] mx-auto">
        
        {/* Sidebar */}
        <aside className="w-64 shrink-0 hidden md:flex flex-col h-[calc(100vh-80px)] sticky top-20 border-r border-neutral-900 overflow-y-auto py-8 pr-6">
          <Link href="/" className="flex items-center gap-2 text-neutral-500 hover:text-white transition-colors text-xs font-mono mb-8 w-fit">
            <ArrowLeft className="w-3 h-3" /> Back to Home
          </Link>
          
          <nav className="flex flex-col gap-8">
            {navGroups.map((group, idx) => (
              <div key={idx} className="flex flex-col gap-3">
                <h4 className="text-xs font-mono font-bold text-neutral-300 uppercase tracking-widest">{group.title}</h4>
                <ul className="flex flex-col gap-2">
                  {group.links.map((link, lIdx) => (
                    <li key={lIdx}>
                      <Link href={link.href} className="text-sm text-neutral-500 hover:text-white transition-colors block">
                        {link.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        {/* Content Area */}
        <main className="flex-1 min-w-0 overflow-hidden">
          <div className="max-w-3xl mx-auto px-8 py-12 md:py-16">
            {children}
          </div>
        </main>
        
      </div>
    </div>
  );
}
