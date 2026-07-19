import { Code2 } from "lucide-react";

export function SourceLink({ path }: { path: string }) {
  const repoUrl = "https://github.com/siddharthakatiyar/ContextOS/blob/main";
  
  return (
    <div className="flex items-center gap-3 bg-neutral-900 border border-neutral-800 px-4 py-3 rounded-lg w-fit my-6 group hover:border-neutral-700 transition-colors">
      <Code2 className="w-4 h-4 text-neutral-500 group-hover:text-white transition-colors" />
      <div className="flex flex-col">
        <span className="text-xs text-neutral-500 font-mono uppercase tracking-widest">Implementation Source</span>
        <a 
          href={`${repoUrl}/${path}`} 
          target="_blank" 
          rel="noreferrer"
          className="text-sm font-mono text-neutral-300 group-hover:text-white transition-colors underline decoration-neutral-700 underline-offset-4"
        >
          {path}
        </a>
      </div>
    </div>
  );
}
