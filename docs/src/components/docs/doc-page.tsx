import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";

interface DocPageProps {
  title: string;
  description: string;
  children: React.ReactNode;
  prev?: { title: string; href: string };
  next?: { title: string; href: string };
}

export function DocPage({ title, description, children, prev, next }: DocPageProps) {
  const techArticleJsonLd = {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: title,
    description,
  };

  return (
    <article className="flex flex-col w-full">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(techArticleJsonLd) }}
      />
      <header className="mb-12 flex flex-col gap-4">
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-white">{title}</h1>
        <p className="text-xl text-neutral-400 font-mono leading-relaxed">{description}</p>
      </header>

      <div className="prose prose-invert prose-neutral max-w-none prose-headings:font-bold prose-headings:tracking-tight prose-h2:text-3xl prose-h2:mt-16 prose-h2:mb-6 prose-h2:border-b prose-h2:border-neutral-900 prose-h2:pb-4 prose-h3:text-2xl prose-h3:mt-12 prose-h4:text-lg prose-p:text-neutral-300 prose-p:leading-relaxed prose-a:text-white prose-a:decoration-neutral-700 hover:prose-a:decoration-white prose-a:underline-offset-4 prose-code:text-neutral-200 prose-code:bg-neutral-900 prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none prose-pre:bg-[#0a0a0a] prose-pre:border prose-pre:border-neutral-800 prose-li:text-neutral-300">
        {children}
      </div>

      {(prev || next) && (
        <div className="mt-24 pt-8 border-t border-neutral-900 flex flex-col sm:flex-row gap-4 justify-between">
          {prev ? (
            <Link href={prev.href} className="flex flex-col gap-2 group p-4 border border-transparent hover:border-neutral-800 hover:bg-neutral-900/50 rounded-lg transition-colors flex-1">
              <span className="text-xs font-mono text-neutral-500 uppercase tracking-widest flex items-center gap-2">
                <ArrowLeft className="w-3 h-3 transition-transform group-hover:-translate-x-1" /> Previous
              </span>
              <span className="text-lg font-medium text-neutral-300 group-hover:text-white transition-colors">{prev.title}</span>
            </Link>
          ) : <div className="flex-1"></div>}
          
          {next ? (
            <Link href={next.href} className="flex flex-col items-end text-right gap-2 group p-4 border border-transparent hover:border-neutral-800 hover:bg-neutral-900/50 rounded-lg transition-colors flex-1">
              <span className="text-xs font-mono text-neutral-500 uppercase tracking-widest flex items-center gap-2">
                Next <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-1" />
              </span>
              <span className="text-lg font-medium text-neutral-300 group-hover:text-white transition-colors">{next.title}</span>
            </Link>
          ) : <div className="flex-1"></div>}
        </div>
      )}
    </article>
  );
}
