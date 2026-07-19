"use client";

import { Clock, HardDrive, AlertTriangle, CheckCircle2 } from "lucide-react";

interface ComplexityProps {
  time: string;
  space: string;
  worstCase: string;
  averageCase: string;
}

export function ComplexityTable({ time, space, worstCase, averageCase }: ComplexityProps) {
  return (
    <div className="flex flex-col border border-neutral-800 rounded-xl overflow-hidden font-mono text-sm my-8 bg-[#0a0a0a]">
      <div className="bg-neutral-900 border-b border-neutral-800 px-6 py-3 font-bold text-neutral-300">
        Complexity Analysis
      </div>
      
      <div className="flex flex-col md:flex-row divide-y md:divide-y-0 md:divide-x divide-neutral-800">
        
        <div className="flex-1 p-6 flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-neutral-500 text-xs uppercase tracking-widest">
              <Clock className="w-3 h-3" /> Time Complexity
            </div>
            <div className="text-xl font-bold text-white">{time}</div>
          </div>
          
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-neutral-500 text-xs uppercase tracking-widest">
              <HardDrive className="w-3 h-3" /> Space Complexity
            </div>
            <div className="text-xl font-bold text-white">{space}</div>
          </div>
        </div>
        
        <div className="flex-1 p-6 flex flex-col gap-6 bg-[#050505]">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-neutral-500 text-xs uppercase tracking-widest">
              <CheckCircle2 className="w-3 h-3 text-[#27c93f]" /> Average Case
            </div>
            <div className="text-neutral-300">{averageCase}</div>
          </div>
          
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-neutral-500 text-xs uppercase tracking-widest">
              <AlertTriangle className="w-3 h-3 text-[#ffbd2e]" /> Worst Case
            </div>
            <div className="text-neutral-300">{worstCase}</div>
          </div>
        </div>
        
      </div>
    </div>
  );
}
