"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

const SCENARIOS = [
  {
    query: "storage",
    target: "database.ts",
    deps: ["schema.ts", "migrations.ts"],
    irrelevant: ["indexer.ts", "cli.ts", "api.ts"],
    tokens: 2104,
  },
  {
    query: "indexing logic",
    target: "indexer.ts",
    deps: ["chunker.ts", "embeddings.ts"],
    irrelevant: ["serve.ts", "ui.tsx", "styles.css"],
    tokens: 3450,
  },
  {
    query: "mcp init",
    target: "init.ts",
    deps: ["config-gen.ts", "database.ts"],
    irrelevant: ["graph.ts", "auth.ts", "worker.ts"],
    tokens: 1820,
  }
];

export function GraphDemo() {
  const [stage, setStage] = useState(0);
  const [scenarioIdx, setScenarioIdx] = useState(0);

  // Stages:
  // 0: Initial (all nodes visible)
  // 1: Search (target highlighted)
  // 2: Expand (lines drawn to deps, deps highlighted)
  // 3: Filter (unrelated nodes fade out)
  // 4: Package (collapse into token count)

  useEffect(() => {
    const sequence = [
      { delay: 1500 }, // Wait at start
      { delay: 1500 }, // Highlight search
      { delay: 1500 }, // Expand
      { delay: 1500 }, // Filter
      { delay: 3000 }, // Package
      { delay: 1000 }, // Reset (brief)
    ];
    
    let currentStep = 0;
    let activeScenario = 0;
    
    const runSequence = async () => {
      while (true) {
        for (const item of sequence) {
          await new Promise(resolve => setTimeout(resolve, item.delay));
          currentStep = (currentStep + 1) % 6;
          setStage(currentStep);
          
          if (currentStep === 0) {
            // Move to next scenario when resetting
            activeScenario = (activeScenario + 1) % SCENARIOS.length;
            setScenarioIdx(activeScenario);
          }
        }
      }
    };

    runSequence();
  }, []);

  const currentScenario = SCENARIOS[scenarioIdx];

  return (
    <div className="w-full border border-neutral-800 bg-[#0a0a0a] rounded-xl overflow-hidden flex flex-col h-[500px] relative">
      
      {/* Header explaining the current stage */}
      <div className="border-b border-neutral-800 p-4 bg-black flex items-center justify-center min-h-[72px]">
        <AnimatePresence mode="wait">
          <motion.div
            key={`${scenarioIdx}-${stage}`}
            initial={{ opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -5 }}
            transition={{ duration: 0.2 }}
            className="font-mono text-sm"
          >
            {stage === 0 && <span className="text-neutral-500">Waiting for query...</span>}
            {stage === 1 && <span className="text-white"><span className="text-neutral-500">Query: </span>"{currentScenario.query}" <span className="text-neutral-500">→ found 1 match</span></span>}
            {stage === 2 && <span className="text-white"><span className="text-neutral-500">Graph Expansion: </span>Resolving imports</span>}
            {stage === 3 && <span className="text-white"><span className="text-neutral-500">Ranking: </span>Pruning irrelevant files</span>}
            {stage >= 4 && <span className="text-white font-bold">✓ Context Package Ready</span>}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Graph Area */}
      <div className="flex-1 relative p-8">
        
        {stage < 4 && (
          <div className="w-full h-full relative">
            
            {/* SVG Lines for dependencies */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none z-0">
              <motion.line 
                x1="45%" y1="40%" x2="70%" y2="20%" 
                stroke="#444" strokeWidth="2" strokeDasharray="4"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ 
                  pathLength: stage >= 2 ? 1 : 0, 
                  opacity: stage >= 2 ? 1 : 0 
                }}
                transition={{ duration: 0.5 }}
              />
              <motion.line 
                x1="45%" y1="40%" x2="70%" y2="60%" 
                stroke="#444" strokeWidth="2" strokeDasharray="4"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ 
                  pathLength: stage >= 2 ? 1 : 0, 
                  opacity: stage >= 2 ? 1 : 0 
                }}
                transition={{ duration: 0.5 }}
              />
            </svg>

            {/* Unrelated Nodes */}
            <motion.div 
              animate={{ opacity: stage >= 3 ? 0.1 : 1 }} 
              className="absolute top-[20%] left-[20%] border border-neutral-700 bg-neutral-900 p-2 text-xs font-mono text-neutral-400 rounded z-10"
            >
              {currentScenario.irrelevant[0]}
            </motion.div>
            <motion.div 
              animate={{ opacity: stage >= 3 ? 0.1 : 1 }} 
              className="absolute top-[70%] left-[25%] border border-neutral-700 bg-neutral-900 p-2 text-xs font-mono text-neutral-400 rounded z-10"
            >
              {currentScenario.irrelevant[1]}
            </motion.div>
            <motion.div 
              animate={{ opacity: stage >= 3 ? 0.1 : 1 }} 
              className="absolute top-[80%] left-[60%] border border-neutral-700 bg-neutral-900 p-2 text-xs font-mono text-neutral-400 rounded z-10"
            >
              {currentScenario.irrelevant[2]}
            </motion.div>
            
            {/* Target Node */}
            <motion.div 
              animate={{ 
                scale: stage >= 1 ? 1.1 : 1, 
                borderColor: stage >= 1 ? '#fff' : '#333', 
                color: stage >= 1 ? '#fff' : '#999',
                backgroundColor: stage >= 1 ? '#111' : '#0a0a0a'
              }} 
              className="absolute top-[40%] left-[45%] border p-2 text-xs font-mono rounded z-20 transition-colors"
            >
              {currentScenario.target}
            </motion.div>
            
            {/* Dependency Nodes */}
            <motion.div 
              animate={{ 
                opacity: 1,
                borderColor: stage >= 2 ? '#aaa' : '#333', 
                color: stage >= 2 ? '#ddd' : '#999',
              }} 
              className="absolute top-[20%] left-[70%] border border-neutral-700 bg-[#0a0a0a] p-2 text-xs font-mono rounded z-20 transition-colors"
            >
              {currentScenario.deps[0]}
            </motion.div>
            <motion.div 
              animate={{ 
                opacity: 1,
                borderColor: stage >= 2 ? '#aaa' : '#333', 
                color: stage >= 2 ? '#ddd' : '#999',
              }} 
              className="absolute top-[60%] left-[70%] border border-neutral-700 bg-[#0a0a0a] p-2 text-xs font-mono rounded z-20 transition-colors"
            >
              {currentScenario.deps[1]}
            </motion.div>
          </div>
        )}
        
        {stage >= 4 && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="w-full h-full flex items-center justify-center"
          >
            <div className="flex flex-col gap-4 text-center w-full max-w-sm">
              <div className="border border-white bg-white text-black px-6 py-3 font-mono text-sm font-bold shadow-[0_0_30px_rgba(255,255,255,0.1)]">
                Context Package Built
              </div>
              <div className="flex flex-col gap-2 font-mono text-xs text-neutral-400 text-left bg-neutral-900/50 p-6 border border-neutral-800 rounded">
                <div className="text-white">+ {currentScenario.target}</div>
                <div className="text-neutral-300 pl-4">↳ import {currentScenario.deps[0]}</div>
                <div className="text-neutral-300 pl-4">↳ import {currentScenario.deps[1]}</div>
                <div className="mt-4 pt-4 border-t border-neutral-800 text-white font-bold flex justify-between">
                  <span>Total Payload:</span>
                  <span>{currentScenario.tokens} Tokens</span>
                </div>
              </div>
            </div>
          </motion.div>
        )}

      </div>
    </div>
  );
}
