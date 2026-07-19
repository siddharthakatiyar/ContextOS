"use client";

import { motion } from "framer-motion";
import { ArrowDown, AlertTriangle, Database } from "lucide-react";

export function IsolationDiagram() {
  return (
    <div className="flex flex-col md:flex-row gap-8 w-full font-mono text-sm">
      
      {/* OLD */}
      <div className="flex-1 border border-neutral-800 bg-[#110505] p-8 rounded-xl flex flex-col items-center">
        <div className="text-neutral-500 font-bold mb-8 tracking-widest uppercase text-xs">Old</div>
        
        <div className="flex w-full justify-center gap-8 mb-4">
          <div className="w-full max-w-[140px] border border-neutral-800 bg-neutral-900 py-3 text-center text-neutral-300">Workspace A</div>
          <div className="w-full max-w-[140px] border border-neutral-800 bg-neutral-900 py-3 text-center text-neutral-300">Workspace B</div>
        </div>
        
        <div className="flex w-full justify-center gap-24 relative h-8">
          <div className="absolute top-0 w-[calc(100%-140px)] h-px bg-neutral-800 border-b border-neutral-800 border-l border-r rounded-b-xl border-t-0 -z-10 translate-y-[-1px]"></div>
          <ArrowDown className="w-4 h-4 text-neutral-600 absolute bottom-0" />
        </div>
        
        <div className="mt-4 w-full max-w-[200px] border border-neutral-700 bg-neutral-800 py-3 text-center text-white flex items-center justify-center gap-2">
          <Database className="w-4 h-4" /> Shared Context
        </div>
        
        <ArrowDown className="w-4 h-4 text-red-800 my-4" />
        
        <div className="w-full max-w-[200px] border border-red-500 bg-red-900/30 text-red-500 font-bold py-4 text-center flex items-center justify-center gap-2">
          <AlertTriangle className="w-4 h-4" /> Cross Contamination
        </div>
      </div>

      {/* NEW */}
      <div className="flex-1 border border-neutral-800 bg-[#0a0a0a] p-8 rounded-xl flex flex-col items-center">
        <div className="text-[#27c93f] font-bold mb-8 tracking-widest uppercase text-xs">New</div>
        
        <div className="flex w-full justify-center gap-8 mb-4">
          <div className="flex flex-col items-center w-full max-w-[140px] gap-2">
            <div className="w-full border border-neutral-800 bg-black py-3 text-center text-white">Workspace A</div>
            <ArrowDown className="w-4 h-4 text-neutral-600" />
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.2 }}
              className="w-full border border-blue-900/50 bg-blue-950/30 text-blue-300 py-3 text-center flex items-center justify-center gap-2"
            >
              <Database className="w-3 h-3" /> .contextos
            </motion.div>
          </div>

          <div className="flex flex-col items-center w-full max-w-[140px] gap-2">
            <div className="w-full border border-neutral-800 bg-black py-3 text-center text-white">Workspace B</div>
            <ArrowDown className="w-4 h-4 text-neutral-600" />
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.4 }}
              className="w-full border border-purple-900/50 bg-purple-950/30 text-purple-300 py-3 text-center flex items-center justify-center gap-2"
            >
              <Database className="w-3 h-3" /> .contextos
            </motion.div>
          </div>
        </div>
        
        <motion.div 
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.8 }}
          className="mt-6 w-full max-w-[300px] border border-neutral-800 bg-neutral-900 text-white font-bold py-4 text-center"
        >
          Independent Databases
        </motion.div>
      </div>

    </div>
  );
}
