"use client";

import { motion } from "framer-motion";
import { ArrowDown } from "lucide-react";

export function ArchitectureDiff() {
  return (
    <div className="flex flex-col border border-neutral-800 rounded-xl overflow-hidden font-mono text-sm w-full">
      
      {/* Header */}
      <div className="flex bg-neutral-900 border-b border-neutral-800 text-neutral-400">
        <div className="flex-1 py-3 px-6 border-r border-neutral-800">Old Retrieval Pipeline</div>
        <div className="flex-1 py-3 px-6">New Retrieval Pipeline</div>
      </div>

      {/* Body */}
      <div className="flex flex-col md:flex-row bg-[#0a0a0a]">
        
        {/* OLD */}
        <div className="flex-1 p-8 border-b md:border-b-0 md:border-r border-neutral-800 bg-[#110505] flex flex-col items-center">
          <div className="flex flex-col items-center w-full max-w-[240px] gap-2">
            <div className="w-full border border-red-900/50 bg-red-950/20 py-3 text-center text-red-300 line-through decoration-red-500/50">
              Read 22 files
            </div>
            <ArrowDown className="w-4 h-4 text-red-900/50" />
            <div className="w-full border border-red-900/50 bg-red-950/20 py-3 text-center text-red-300 line-through decoration-red-500/50">
              Embedding Search
            </div>
            <ArrowDown className="w-4 h-4 text-red-900/50" />
            <div className="w-full border border-red-900 bg-red-900/40 py-3 text-center text-red-200">
              Context Package
            </div>
          </div>
        </div>

        {/* NEW */}
        <div className="flex-1 p-8 bg-[#05110a] flex flex-col items-center relative">
          
          <div className="flex flex-col items-center w-full max-w-[240px] gap-2">
            <motion.div 
              initial={{ opacity: 0, x: -10 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              className="w-full border border-green-900/50 bg-green-950/30 py-3 text-center text-green-300"
            >
              + BM25 Pre-filter
            </motion.div>
            <ArrowDown className="w-4 h-4 text-green-900/50" />
            
            <motion.div 
              initial={{ opacity: 0, x: -10 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.1 }}
              className="w-full border border-green-900/50 bg-green-950/30 py-3 text-center text-green-300"
            >
              + Graph Expansion
            </motion.div>
            <ArrowDown className="w-4 h-4 text-green-900/50" />

            <motion.div 
              initial={{ opacity: 0, x: -10 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.2 }}
              className="w-full border border-green-900/50 bg-green-950/30 py-3 text-center text-green-300"
            >
              + Intent Ranking
            </motion.div>
            <ArrowDown className="w-4 h-4 text-green-900/50" />

            <motion.div 
              initial={{ opacity: 0, x: -10 }}
              whileInView={{ opacity: 1, x: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.3 }}
              className="w-full border border-green-900/50 bg-green-950/30 py-3 text-center text-green-300"
            >
              + Compression
            </motion.div>
            <ArrowDown className="w-4 h-4 text-green-900/50" />
            
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ delay: 0.4 }}
              className="w-full border border-green-500 bg-green-900/40 py-3 text-center text-green-100 font-bold shadow-[0_0_15px_rgba(39,201,63,0.1)]"
            >
              Context Package
            </motion.div>
          </div>
        </div>

      </div>
    </div>
  );
}
