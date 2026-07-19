"use client";

import { useState, useEffect, useRef } from "react";
import { motion, useInView, AnimatePresence } from "framer-motion";
import { ArrowDown } from "lucide-react";

const pipelineSteps = [
  { id: "repo", title: "Repository", desc: "Your raw codebase across thousands of files." },
  { id: "index", title: "Index", desc: "Files parsed via Tree-sitter into AST chunks and symbols." },
  { id: "search", title: "Search", desc: "BM25 keyword matches combined with Semantic Embeddings." },
  { id: "graph", title: "Graph Expansion", desc: "Follow imports and references to gather full context." },
  { id: "rank", title: "Intent Ranking", desc: "Score symbols based on relevance to the user's intent." },
  { id: "compress", title: "Compression", desc: "Truncate low-signal lines and fit within the token budget." },
  { id: "llm", title: "LLM Context", desc: "The final surgical context package passed to Claude or GPT." },
];

export function PipelineVisualizer() {
  const [activeStep, setActiveStep] = useState(0);
  const [isHovered, setIsHovered] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(containerRef, { amount: 0.5 });

  useEffect(() => {
    if (!isInView || isHovered) return;
    const interval = setInterval(() => {
      setActiveStep((prev) => (prev + 1) % pipelineSteps.length);
    }, 3000);
    return () => clearInterval(interval);
  }, [isInView, isHovered]);

  return (
    <div 
      ref={containerRef} 
      className="w-full flex flex-col md:flex-row gap-12 items-start"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      
      {/* Pipeline Path */}
      <div className="flex flex-col items-center flex-1 w-full relative">
        
        {/* Animated Packets Track */}
        <div className="absolute top-0 bottom-0 left-1/2 w-0.5 bg-neutral-900 -translate-x-1/2 z-0" />
        
        {pipelineSteps.map((step, idx) => (
          <div 
            key={step.id} 
            className="flex flex-col items-center w-full group cursor-pointer relative z-10" 
            onMouseEnter={() => setActiveStep(idx)}
          >
            {/* The Stage Node */}
            <motion.div 
              className={`w-full py-4 px-6 border ${
                activeStep === idx 
                  ? 'border-white bg-white text-black shadow-[0_0_30px_rgba(255,255,255,0.2)]' 
                  : 'border-neutral-800 bg-black text-white hover:border-neutral-600'
              } text-center font-mono text-sm font-semibold transition-all duration-300`}
            >
              {step.title}
            </motion.div>
            
            {/* The Arrow connecting stages */}
            {idx < pipelineSteps.length - 1 && (
              <div className="py-4 text-neutral-600 relative h-12 flex items-center justify-center">
                <ArrowDown className="w-4 h-4 z-10 bg-black" />
                {/* Flowing Packet */}
                {activeStep === idx && (
                  <motion.div
                    className="absolute w-2 h-2 bg-white rounded-full shadow-[0_0_10px_rgba(255,255,255,0.8)] z-20"
                    initial={{ top: 0, opacity: 0 }}
                    animate={{ top: "100%", opacity: [0, 1, 1, 0] }}
                    transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                  />
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Explanation Panel */}
      <div className="flex-1 w-full bg-neutral-900 border border-neutral-800 p-8 min-h-[300px] sticky top-24">
        <h3 className="font-mono text-xs text-neutral-500 uppercase tracking-widest mb-4">Pipeline Stage {activeStep + 1}</h3>
        <AnimatePresence mode="wait">
          <motion.div
            key={activeStep}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
          >
            <h2 className="text-2xl font-bold mb-4 text-white">{pipelineSteps[activeStep].title}</h2>
            <p className="text-neutral-400 text-lg leading-relaxed">{pipelineSteps[activeStep].desc}</p>
          </motion.div>
        </AnimatePresence>
      </div>

    </div>
  );
}
