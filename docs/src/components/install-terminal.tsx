"use client";

import { useState, useEffect, useRef } from "react";
import { motion, useInView } from "framer-motion";

export function InstallTerminal() {
  const [step, setStep] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const isInView = useInView(containerRef, { amount: 0.5 });
  const [hasRun, setHasRun] = useState(false);

  useEffect(() => {
    if (!isInView || hasRun) return;
    setHasRun(true);

    const sequence = [
      { delay: 500 },  // Wait
      { delay: 1500 }, // Type command
      { delay: 400 },  // Downloading
      { delay: 800 },  // Installing
      { delay: 400 },  // Done
      { delay: 500 },  // Welcome
    ];

    let currentStep = 0;
    
    const runSequence = async () => {
      for (const item of sequence) {
        await new Promise(resolve => setTimeout(resolve, item.delay));
        currentStep++;
        setStep(currentStep);
      }
    };

    runSequence();
  }, [isInView, hasRun]);

  return (
    <div ref={containerRef} className="w-full max-w-2xl mx-auto rounded-xl border border-neutral-800 bg-[#0a0a0a] font-mono text-sm shadow-2xl overflow-hidden text-neutral-400">
      {/* Terminal Header */}
      <div className="flex items-center px-4 py-3 border-b border-neutral-800 bg-neutral-900/80">
        <div className="flex gap-2">
          <div className="h-3 w-3 rounded-full bg-[#ff5f56]" />
          <div className="h-3 w-3 rounded-full bg-[#ffbd2e]" />
          <div className="h-3 w-3 rounded-full bg-[#27c93f]" />
        </div>
      </div>
      
      {/* Terminal Body */}
      <div className="p-6 h-[240px] flex flex-col gap-3 text-left items-start">
        
        {step >= 1 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <span className="text-neutral-500">{">"} </span>
            <span className="text-white font-medium">
              <Typewriter text="npm install -g @siddharthakatiyar/contextos" speed={30} />
            </span>
          </motion.div>
        )}

        {step >= 2 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-2 text-neutral-400">
            Fetching packages...
          </motion.div>
        )}
        
        {step >= 3 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="text-neutral-400">
            Installing dependencies...
          </motion.div>
        )}
        
        {step >= 4 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-2 text-[#27c93f] font-medium flex gap-2">
            <span>✓</span>
            <span>Successfully installed @siddharthakatiyar/contextos</span>
          </motion.div>
        )}

        {step >= 5 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4 text-white font-bold">
            Welcome to ContextOS. Run `contextos init` to begin.
          </motion.div>
        )}
        
        {step < 6 && (
          <motion.div 
            animate={{ opacity: [1, 0] }} 
            transition={{ repeat: Infinity, duration: 0.8 }}
            className={`w-2.5 h-4 bg-neutral-500 inline-block ml-1 ${step === 0 ? 'mt-0' : 'mt-2'}`}
          />
        )}
      </div>
    </div>
  );
}

function Typewriter({ text, speed = 50 }: { text: string, speed?: number }) {
  const [displayed, setDisplayed] = useState("");

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      setDisplayed(text.substring(0, i + 1));
      i++;
      if (i >= text.length) {
        clearInterval(interval);
      }
    }, speed);
    return () => clearInterval(interval);
  }, [text, speed]);

  return <span>{displayed}</span>;
}
