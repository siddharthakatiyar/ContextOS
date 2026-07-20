import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { CopyCommand } from "@/components/copy-command";
import { getChangelog, getChangelogEntry, formatReleaseDate } from "@/lib/changelog";
import { buildMetadata } from "@/lib/seo";

export function generateStaticParams() {
  return getChangelog().map((entry) => ({ version: entry.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ version: string }>;
}): Promise<Metadata> {
  const { version } = await params;
  const entry = getChangelogEntry(version);

  if (!entry) {
    return buildMetadata({
      title: "Release Not Found",
      description: "This ContextOS release could not be found.",
      path: `/releases/${version}`,
    });
  }

  return buildMetadata({
    title: `ContextOS ${entry.slug}`,
    description: entry.summary ?? `Changelog and release notes for ContextOS ${entry.slug}, published ${formatReleaseDate(entry.date)}.`,
    path: `/releases/${entry.slug}`,
  });
}

export default async function ReleasePage({
  params,
}: {
  params: Promise<{ version: string }>;
}) {
  const { version } = await params;
  const entry = getChangelogEntry(version);

  if (!entry) {
    notFound();
  }

  const entries = getChangelog();
  const currentIndex = entries.findIndex((e) => e.slug === entry.slug);
  const previousReleases = entries.slice(currentIndex + 1, currentIndex + 4);

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
            <h1 className="text-5xl md:text-7xl font-bold tracking-tight">ContextOS {entry.slug}</h1>
            <div className="hidden md:flex flex-col text-xs font-mono text-neutral-500 uppercase tracking-widest gap-1 border-l border-neutral-800 pl-4">
              <span>{formatReleaseDate(entry.date)}</span>
              {entry.hasBreakingChange && (
                <span className="text-red-500">Contains Breaking Changes</span>
              )}
            </div>
          </div>

          {entry.summary && (
            <p className="text-2xl text-neutral-300 max-w-3xl mt-4">
              {entry.summary}
            </p>
          )}

          <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 mt-8">
            <CopyCommand command="npm install -g @siddharthakatiyar/contextos@latest" />
            <a href={`https://github.com/siddharthakatiyar/ContextOS/releases/tag/${entry.slug}`} target="_blank" rel="noreferrer" className="text-neutral-400 hover:text-white transition-colors font-mono text-sm underline underline-offset-4">
              View on GitHub ↗
            </a>
          </div>
        </section>

        {/* CHANGELOG SECTIONS */}
        <section className="flex flex-col gap-8 py-16 border-t border-neutral-900 mt-16">
          {entry.sections.map((section) => (
            <div key={section.heading} className="flex flex-col gap-4">
              <h2 className="text-2xl font-bold tracking-tight">{section.heading}</h2>
              <ul className="flex flex-col gap-3">
                {section.bullets.map((bullet, idx) => (
                  <li key={idx} className="flex gap-3 text-neutral-300 font-mono text-sm">
                    <span className="text-neutral-700">-</span>
                    <span>
                      {bullet.lead && (
                        <span className="text-white font-semibold">{bullet.lead}: </span>
                      )}
                      {bullet.rest}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>

      </main>

      {/* Footer / Timeline */}
      {previousReleases.length > 0 && (
        <footer className="border-t border-neutral-900 py-16 px-8 text-sm font-mono">
          <div className="max-w-5xl mx-auto flex flex-col gap-8">
            <div className="text-neutral-500 uppercase tracking-widest">Previous Releases</div>
            <div className="flex gap-8">
              {previousReleases.map((release) => (
                <Link key={release.slug} href={`/releases/${release.slug}`} className="text-neutral-400 hover:text-white transition-colors">
                  {release.slug}
                </Link>
              ))}
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
