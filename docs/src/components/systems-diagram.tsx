"use client";

import { useState, useEffect } from "react";
import { motion } from "framer-motion";

function Counter({ from, to, duration, suffix = "" }: { from: number, to: number, duration: number, suffix?: string }) {
  const [count, setCount] = useState(from);
  
  useEffect(() => {
    let startTimestamp: number | null = null;
    let animationFrame: number;
    
    const step = (timestamp: number) => {
      if (!startTimestamp) startTimestamp = timestamp;
      const progress = Math.min((timestamp - startTimestamp) / duration, 1);
      setCount(Math.floor(progress * (to - from) + from));
      if (progress < 1) {
        animationFrame = window.requestAnimationFrame(step);
      }
    };
    animationFrame = window.requestAnimationFrame(step);
    
    return () => window.cancelAnimationFrame(animationFrame);
  }, [from, to, duration]);

  return <span>{count}{suffix}</span>;
}

export function SystemsDiagram() {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    // Stage timings for animation
    const sequence = [
      { delay: 1000 }, // 0 Wait
      { delay: 600 },  // 1 Read auth.ts
      { delay: 600 },  // 2 Read database.ts
      { delay: 600 },  // 3 Read queue.ts
      { delay: 600 },  // 4 Read redis.ts
      { delay: 1200 }, // 5 Token count exploding to 28,000
      { delay: 1200 }, // 6 Context warning & Hallucination
      { delay: 1500 }, // 7 WITH: Search
      { delay: 1000 }, // 8 WITH: Expand Graph
      { delay: 1000 }, // 9 WITH: Rank & Extract
      { delay: 1000 }, // 10 WITH: 1328 Tokens
      { delay: 2000 }, // 11 WITH: Correct Answer
      { delay: 3000 }, // 12 Reset wait
    ];

    let currentStep = 0;
    let isActive = true;

    const runSequence = async () => {
      while (isActive) {
        for (const item of sequence) {
          if (!isActive) return;
          await new Promise(resolve => setTimeout(resolve, item.delay));
          currentStep = (currentStep + 1) % sequence.length;
          setStage(currentStep);
        }
      }
    };

    runSequence();
    return () => { isActive = false; };
  }, []);

  return (
    <div className="w-full flex flex-col md:flex-row border border-neutral-800 bg-neutral-900 rounded-xl overflow-hidden text-sm font-mono h-auto min-h-[500px]">
      
      {/* Without ContextOS */}
      <div className="flex-1 p-8 border-b md:border-b-0 md:border-r border-neutral-800 flex flex-col items-center">
        <h3 className="text-neutral-500 uppercase tracking-widest mb-8">Without ContextOS</h3>
        
        <div className="flex flex-col items-center w-full gap-3 relative">
          
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: stage >= 1 ? 1 : 0 }} className="text-neutral-400 w-full max-w-[240px] flex gap-2 items-center">
            <div className="w-1.5 h-1.5 bg-neutral-600 rounded-full"></div> read auth.ts
          </motion.div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: stage >= 2 ? 1 : 0 }} className="text-neutral-400 w-full max-w-[240px] flex gap-2 items-center">
            <div className="w-1.5 h-1.5 bg-neutral-600 rounded-full"></div> read database.ts
          </motion.div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: stage >= 3 ? 1 : 0 }} className="text-neutral-400 w-full max-w-[240px] flex gap-2 items-center">
            <div className="w-1.5 h-1.5 bg-neutral-600 rounded-full"></div> read queue.ts
          </motion.div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: stage >= 4 ? 1 : 0 }} className="text-neutral-400 w-full max-w-[240px] flex gap-2 items-center">
            <div className="w-1.5 h-1.5 bg-neutral-600 rounded-full"></div> read redis.ts
          </motion.div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: stage >= 5 ? 1 : 0 }} className="text-neutral-400 w-full max-w-[240px] flex gap-2 items-center">
            <div className="w-1.5 h-1.5 bg-neutral-600 rounded-full"></div> ...
          </motion.div>

          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }} 
            animate={{ opacity: stage >= 5 ? 1 : 0, scale: stage >= 5 ? 1 : 0.9 }} 
            className="mt-6 border border-neutral-700 bg-black py-4 px-6 w-full max-w-[240px] text-center"
          >
            <div className="text-neutral-500 text-xs mb-1">Total Tokens</div>
            <div className="text-white text-xl font-bold">
              {stage >= 5 ? (stage >= 6 ? "28,000+" : <Counter from={400} to={28000} duration={1000} />) : "0"}
            </div>
          </motion.div>

          <motion.div 
            initial={{ opacity: 0, y: -10 }} 
            animate={{ opacity: stage >= 6 ? 1 : 0, y: stage >= 6 ? 0 : -10 }} 
            className="flex flex-col items-center w-full gap-3 mt-3"
            style={{ pointerEvents: stage >= 6 ? 'auto' : 'none' }}
          >
            <div className="h-6 w-px bg-red-900"></div>
            <div className="border border-red-900/50 bg-red-950/20 py-3 px-6 w-full max-w-[240px] text-center text-red-400">Context Window Warning</div>
            <div className="h-6 w-px bg-red-900"></div>
            <div className="border border-red-500 bg-red-900/30 py-3 px-6 w-full max-w-[240px] text-center text-red-500 font-bold">Hallucination</div>
          </motion.div>

        </div>
      </div>

      {/* With ContextOS */}
      <div className="flex-1 p-8 bg-[#0a0a0a] flex flex-col items-center">
        <h3 className="text-white font-bold uppercase tracking-widest mb-8">With ContextOS</h3>
        
        <div className="flex flex-col items-center w-full gap-3 relative">
          
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: stage >= 7 ? 1 : 0 }} className="border border-neutral-800 bg-black py-3 px-6 w-full max-w-[240px] text-center text-white">
            Search
          </motion.div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: stage >= 8 ? 1 : 0 }} className="h-6 w-px bg-neutral-800"></motion.div>
          
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: stage >= 8 ? 1 : 0 }} className="border border-neutral-800 bg-black py-3 px-6 w-full max-w-[240px] text-center text-white">
            Expand Graph
          </motion.div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: stage >= 9 ? 1 : 0 }} className="h-6 w-px bg-neutral-800"></motion.div>
          
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: stage >= 9 ? 1 : 0 }} className="border border-neutral-800 bg-black py-3 px-6 w-full max-w-[240px] text-center text-white">
            Rank Symbols
          </motion.div>
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: stage >= 10 ? 1 : 0 }} className="h-6 w-px bg-neutral-800"></motion.div>
          
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: stage >= 10 ? 1 : 0 }} className="border border-neutral-800 bg-black py-3 px-6 w-full max-w-[240px] text-center text-white">
            Extract
          </motion.div>
          
          <motion.div 
            initial={{ opacity: 0, y: -10 }} 
            animate={{ opacity: stage >= 10 ? 1 : 0, y: stage >= 10 ? 0 : -10 }} 
            className="mt-6 flex flex-col items-center w-full gap-3"
            style={{ pointerEvents: stage >= 10 ? 'auto' : 'none' }}
          >
            <div className="border border-neutral-700 bg-black py-4 px-6 w-full max-w-[240px] text-center">
              <div className="text-neutral-500 text-xs mb-1">Total Tokens</div>
              <div className="text-white text-xl font-bold">1,328</div>
            </div>
          </motion.div>

          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }} 
            animate={{ opacity: stage >= 11 ? 1 : 0, scale: stage >= 11 ? 1 : 0.9 }} 
            className="mt-3 flex flex-col items-center w-full gap-3"
            style={{ pointerEvents: stage >= 11 ? 'auto' : 'none' }}
          >
            <div className="h-6 w-px bg-neutral-600"></div>
            <div className="border border-white bg-white text-black py-3 px-6 w-full max-w-[240px] text-center font-bold shadow-[0_0_20px_rgba(255,255,255,0.1)]">
              Correct Answer
            </div>
          </motion.div>
          
        </div>
      </div>

    </div>
  );
}
