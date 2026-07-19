"use client";

import { useState, useEffect, useRef } from "react";
import { motion, useInView } from "framer-motion";
import { ArrowDown } from "lucide-react";

export function TokenComparison() {
  const [step, setStep] = useState(0);
  const ref = useRef(null);
  const isInView = useInView(ref, { amount: 0.5 });

  useEffect(() => {
    if (!isInView) return;
    
    const interval = setInterval(() => {
      setStep((prev) => (prev + 1) % 4);
    }, 1500);
    
    return () => clearInterval(interval);
  }, [isInView]);

  return (
    <div ref={ref} className="flex flex-col md:flex-row gap-8 w-full font-mono text-sm">
      
      {/* OLD */}
      <div className="flex-1 border border-red-900/30 bg-[#110505] p-8 rounded-xl flex flex-col items-center">
        <div className="text-red-500 font-bold mb-8 tracking-widest uppercase text-xs">Old</div>
        
        <div className="flex flex-col items-center w-full max-w-[200px] gap-2">
          <div className="w-full border border-red-900 bg-red-950 py-3 text-center text-red-200">Repository</div>
          <ArrowDown className="w-4 h-4 text-red-800" />
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: step >= 1 ? 1 : 0 }} 
            className="w-full border border-red-900 bg-red-950 py-3 text-center text-red-200"
          >
            Entire files
          </motion.div>
          <ArrowDown className={`w-4 h-4 text-red-800 transition-opacity ${step >= 2 ? 'opacity-100' : 'opacity-0'}`} />
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }} 
            animate={{ opacity: step >= 2 ? 1 : 0, scale: step >= 2 ? 1 : 0.9 }} 
            className="w-full border border-red-500 bg-red-900 text-white font-bold py-4 text-center text-lg"
          >
            28,000 tokens
          </motion.div>
        </div>
      </div>

      {/* NEW */}
      <div className="flex-1 border border-neutral-800 bg-[#0a0a0a] p-8 rounded-xl flex flex-col items-center">
        <div className="text-[#27c93f] font-bold mb-8 tracking-widest uppercase text-xs">New</div>
        
        <div className="flex flex-col items-center w-full max-w-[200px] gap-2">
          <div className="w-full border border-neutral-800 bg-black py-3 text-center text-white">Repository</div>
          <ArrowDown className="w-4 h-4 text-neutral-600" />
          
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: step >= 1 ? 1 : 0 }} 
            className="w-full border border-neutral-800 bg-black py-3 text-center text-white"
          >
            Functions
          </motion.div>
          <ArrowDown className={`w-4 h-4 text-neutral-600 transition-opacity ${step >= 2 ? 'opacity-100' : 'opacity-0'}`} />
          
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: step >= 2 ? 1 : 0 }} 
            className="w-full border border-neutral-800 bg-black py-3 text-center text-white"
          >
            Dependencies
          </motion.div>
          <ArrowDown className={`w-4 h-4 text-neutral-600 transition-opacity ${step >= 3 ? 'opacity-100' : 'opacity-0'}`} />
          
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }} 
            animate={{ opacity: step >= 3 ? 1 : 0, scale: step >= 3 ? 1 : 0.9 }} 
            className="w-full border border-white bg-white text-black font-bold py-4 text-center text-lg shadow-[0_0_20px_rgba(255,255,255,0.1)]"
          >
            1,328 tokens
          </motion.div>
        </div>
      </div>

    </div>
  );
}
