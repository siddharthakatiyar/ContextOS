'use client';

import { motion, useInView } from 'framer-motion';
import { useRef } from 'react';

export function PerformanceCharts() {
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.2 });

  return (
    <div ref={ref} className="flex flex-col gap-12 font-mono text-sm w-full">
      {/* Chart 1: Token Usage */}
      <div className="flex flex-col gap-4">
        <div className="flex justify-between text-neutral-400">
          <span>Token Usage (Average per query)</span>
          <span className="text-xs">Lower is better</span>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <div className="w-20 text-neutral-500 text-right">Previous</div>
            <div className="flex-1 h-8 bg-[#1a1a1a] rounded relative overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: isInView ? '100%' : 0 }}
                transition={{ duration: 1, ease: 'easeOut' }}
                className="absolute top-0 bottom-0 left-0 bg-neutral-800"
              />
            </div>
            <div className="w-20 text-white font-bold">28,000</div>
          </div>

          <div className="flex items-center gap-4">
            <div className="w-20 text-white font-bold text-right">Current</div>
            <div className="flex-1 h-8 bg-[#1a1a1a] rounded relative overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: isInView ? '5%' : 0 }}
                transition={{ duration: 1, ease: 'easeOut', delay: 0.2 }}
                className="absolute top-0 bottom-0 left-0 bg-white"
              />
            </div>
            <div className="w-20 text-white font-bold">1,328</div>
          </div>
        </div>
      </div>

      {/* Chart 2: Latency */}
      <div className="flex flex-col gap-4">
        <div className="flex justify-between text-neutral-400">
          <span>Retrieval Latency (ms)</span>
          <span className="text-xs">Lower is better</span>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <div className="w-20 text-neutral-500 text-right">Previous</div>
            <div className="flex-1 h-8 bg-[#1a1a1a] rounded relative overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: isInView ? '100%' : 0 }}
                transition={{ duration: 1, ease: 'easeOut' }}
                className="absolute top-0 bottom-0 left-0 bg-neutral-800"
              />
            </div>
            <div className="w-20 text-white font-bold">312</div>
          </div>

          <div className="flex items-center gap-4">
            <div className="w-20 text-white font-bold text-right">Current</div>
            <div className="flex-1 h-8 bg-[#1a1a1a] rounded relative overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: isInView ? '13%' : 0 }}
                transition={{ duration: 1, ease: 'easeOut', delay: 0.2 }}
                className="absolute top-0 bottom-0 left-0 bg-white"
              />
            </div>
            <div className="w-20 text-white font-bold">42</div>
          </div>
        </div>
      </div>

      {/* Chart 3: Indexing Speed */}
      <div className="flex flex-col gap-4">
        <div className="flex justify-between text-neutral-400">
          <span>Indexing Speed (Files / sec)</span>
          <span className="text-xs">Higher is better</span>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-4">
            <div className="w-20 text-neutral-500 text-right">Previous</div>
            <div className="flex-1 h-8 bg-[#1a1a1a] rounded relative overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: isInView ? '25%' : 0 }}
                transition={{ duration: 1, ease: 'easeOut' }}
                className="absolute top-0 bottom-0 left-0 bg-neutral-800"
              />
            </div>
            <div className="w-20 text-white font-bold">120</div>
          </div>

          <div className="flex items-center gap-4">
            <div className="w-20 text-white font-bold text-right">Current</div>
            <div className="flex-1 h-8 bg-[#1a1a1a] rounded relative overflow-hidden">
              <motion.div
                initial={{ width: 0 }}
                animate={{ width: isInView ? '100%' : 0 }}
                transition={{ duration: 1, ease: 'easeOut', delay: 0.2 }}
                className="absolute top-0 bottom-0 left-0 bg-white"
              />
            </div>
            <div className="w-20 text-white font-bold">850</div>
          </div>
        </div>
      </div>
    </div>
  );
}
