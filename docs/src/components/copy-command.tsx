"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";

export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex items-center gap-3 bg-[#0a0a0a] border border-neutral-800 rounded-lg px-4 py-3 font-mono text-sm text-neutral-300 shadow-lg">
      <span className="text-neutral-600">$</span>
      <span>{command}</span>
      <button 
        onClick={handleCopy}
        className="ml-4 text-neutral-500 hover:text-white transition-colors"
        aria-label="Copy command"
      >
        {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
      </button>
    </div>
  );
}
