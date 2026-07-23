import Link from "next/link";
import Image from "next/image";
import { ArrowRight } from "lucide-react";
import queryWhereGif from "../../../../public/query-where.gif";
import { CopyCommand } from "@/components/copy-command";
import { getChangelog, formatReleaseDate } from "@/lib/changelog";
import { getReleaseBadge } from "@/lib/release-badge";
import { buildMetadata } from "@/lib/seo";

export const metadata = buildMetadata({
  title: "Releases",
  description: "Changelog and release notes for ContextOS.",
  path: "/releases",
});

const MAX_HIGHLIGHTS = 5;

function getHighlights(entry: ReturnType<typeof getChangelog>[number]) {
  const bullets = entry.sections.flatMap((section) => section.bullets);
  const leads = bullets.filter((bullet) => bullet.lead).map((bullet) => bullet.lead as string);
  if (leads.length > 0) return leads.slice(0, MAX_HIGHLIGHTS);
  return bullets.slice(0, MAX_HIGHLIGHTS).map((bullet) => bullet.rest || bullet.raw);
}

function getReleases() {
  const entries = getChangelog();
  return entries.map((entry, idx) => ({
    version: entry.slug,
    date: formatReleaseDate(entry.date),
    type: getReleaseBadge(entry.version, idx === entries.length - 1),
    description: entry.summary ?? "",
    highlights: getHighlights(entry),
    link: `/releases/${entry.slug}`,
    active: idx === 0,
  }));
}

export default function ReleasesPage() {
  const releases = getReleases();
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
          <a href="https://siddhartha.work/blog" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">Blog ↗</a>
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
          <div className="w-full rounded-xl overflow-hidden border border-neutral-800 shadow-2xl mb-8">
            <Image src={queryWhereGif} alt="Claude Code using ContextOS" className="w-full object-cover" unoptimized />
          </div>

          {/* Timeline Line */}
          <div className="absolute left-0 top-[400px] bottom-0 w-px bg-neutral-900 ml-4 hidden md:block"></div>

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

                <div className="mt-4 pt-4 border-t border-neutral-800">
                  <Link href={release.link} className="inline-flex items-center gap-2 text-white font-semibold hover:text-neutral-300 transition-colors">
                    View Release <ArrowRight className="w-4 h-4" />
                  </Link>
                </div>
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
          <Link href="/docs" className="hover:text-white transition-colors">Documentation</Link>
          <Link href="https://github.com/siddharthakatiyar/ContextOS" className="hover:text-white transition-colors">GitHub</Link>
          <a href="https://siddhartha.work/blog" target="_blank" rel="noreferrer" className="hover:text-white transition-colors">Blog ↗</a>
        </div>
      </footer>
    </div>
  );
}
