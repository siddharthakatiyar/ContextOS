"use client";

import { useState, useEffect, useRef } from "react";
import { useInView, animate } from "framer-motion";

export function ReleaseHeroMetrics() {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-8 py-16 border-y border-neutral-900 mt-16 mb-24">
      <div className="flex flex-col gap-2 border-l border-neutral-800 pl-6">
        <div className="text-5xl font-bold font-mono text-white flex">
          <Counter from={0} to={90} duration={2000} delay={0.1} suffix="%" />
        </div>
        <div className="text-neutral-500 font-mono text-sm uppercase tracking-widest mt-2">Less context sent</div>
      </div>
      <div className="flex flex-col gap-2 border-l border-neutral-800 pl-6">
        <div className="text-5xl font-bold font-mono text-white flex">
          <Counter from={300} to={42} duration={2000} delay={0.2} suffix="ms" />
        </div>
        <div className="text-neutral-500 font-mono text-sm uppercase tracking-widest mt-2">Median retrieval</div>
      </div>
      <div className="flex flex-col gap-2 border-l border-neutral-800 pl-6">
        <div className="text-5xl font-bold font-mono text-white">Zero</div>
        <div className="text-neutral-500 font-mono text-sm uppercase tracking-widest mt-2">Cross-contamination</div>
      </div>
      <div className="flex flex-col gap-2 border-l border-neutral-800 pl-6">
        <div className="text-5xl font-bold font-mono text-white">SQLite</div>
        <div className="text-neutral-500 font-mono text-sm uppercase tracking-widest mt-2">No external vector DB</div>
      </div>
    </div>
  );
}

function Counter({ from, to, duration, delay = 0, suffix = "" }: { from: number, to: number, duration: number, delay?: number, suffix?: string }) {
  const [count, setCount] = useState(from);
  const ref = useRef(null);
  const isInView = useInView(ref, { once: true, amount: 0.5 });
  
  useEffect(() => {
    if (!isInView) return;
    
    const timeout = setTimeout(() => {
      const controls = animate(from, to, {
        duration: duration / 1000,
        ease: "easeOut",
        onUpdate(value) {
          setCount(Math.round(value));
        }
      });
      return () => controls.stop();
    }, delay * 1000);
    
    return () => clearTimeout(timeout);
  }, [from, to, duration, delay, isInView]);

  return <span ref={ref}>{count.toLocaleString()}{suffix}</span>;
}
