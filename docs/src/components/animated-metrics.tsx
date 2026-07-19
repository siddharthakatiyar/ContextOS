"use client";

import { useState, useEffect, useRef } from "react";
import { useInView, animate } from "framer-motion";

export function AnimatedMetrics() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
      <div className="flex flex-col gap-2">
        <div className="text-4xl font-bold font-mono text-white flex">
          <Counter from={28000} to={1328} duration={2000} delay={0.2} />
        </div>
        <div className="text-neutral-500 font-mono text-sm">Fewer tokens sent to LLMs</div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-4xl font-bold font-mono text-white flex">
          <Counter from={312} to={42} duration={2000} delay={0.4} suffix="ms" />
        </div>
        <div className="text-neutral-500 font-mono text-sm">Average retrieval latency</div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-4xl font-bold font-mono text-white">SQLite</div>
        <div className="text-neutral-500 font-mono text-sm">Backed, zero external DBs</div>
      </div>
      <div className="flex flex-col gap-2">
        <div className="text-4xl font-bold font-mono text-white">AST</div>
        <div className="text-neutral-500 font-mono text-sm">Aware semantic chunking</div>
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
    
    // Slight delay before starting animation
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
