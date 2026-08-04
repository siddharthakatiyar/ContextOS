'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, animate, useReducedMotion } from 'framer-motion';

function LoadingBar({ duration = 500 }: { duration?: number }) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const p = Math.min(100, Math.floor((elapsed / duration) * 100));
      setProgress(p);
      if (p === 100) clearInterval(interval);
    }, 50);
    return () => clearInterval(interval);
  }, [duration]);

  const blocks = Math.floor(progress / 10);
  const bar = '█'.repeat(blocks) + '░'.repeat(10 - blocks);

  return (
    <span>
      {bar} {progress}%
    </span>
  );
}

function Counter({
  from,
  to,
  duration,
  suffix = ''
}: {
  from: number;
  to: number;
  duration: number;
  suffix?: string;
}) {
  const [count, setCount] = useState(from);

  useEffect(() => {
    const controls = animate(from, to, {
      duration: duration / 1000,
      onUpdate(value) {
        setCount(Math.round(value));
      }
    });
    return () => controls.stop();
  }, [from, to, duration]);

  return (
    <span>
      {count}
      {suffix}
    </span>
  );
}

function Typewriter({
  text,
  speed = 50,
  onComplete
}: {
  text: string;
  speed?: number;
  onComplete?: () => void;
}) {
  const [displayed, setDisplayed] = useState('');

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      setDisplayed(text.substring(0, i + 1));
      i++;
      if (i >= text.length) {
        clearInterval(interval);
        if (onComplete) onComplete();
      }
    }, speed);
    return () => clearInterval(interval);
  }, [text, speed, onComplete]);

  return <span>{displayed}</span>;
}

export function HeroTerminal() {
  const [step, setStep] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = useReducedMotion();

  useEffect(() => {
    const sequence = [
      { delay: 800 }, // 0 Wait before typing
      { delay: 1500 }, // 1 > explain authentication flow
      { delay: 200 }, // 2 Searching index...
      { delay: 600 }, // 3 Loading bar
      { delay: 800 }, // 4 42 candidate files found
      { delay: 400 }, // 5 Expanding dependency graph...
      { delay: 800 }, // 6 + auth.ts, etc
      { delay: 400 }, // 7 Ranking symbols...
      { delay: 1000 }, // 8 Loading bar 2
      { delay: 400 }, // 9 Compressing...
      { delay: 1500 }, // 10 8192 -> 1328 tokens
      { delay: 500 }, // 11 Ready
      { delay: 4000 } // 12 Restart wait
    ];

    let currentStep = 0;
    let isActive = true;

    const runSequence = async () => {
      while (isActive) {
        for (let i = 0; i < sequence.length; i++) {
          if (!isActive) return;
          await new Promise((resolve) => setTimeout(resolve, sequence[i].delay));
          currentStep = (currentStep + 1) % sequence.length;
          setStep(currentStep);

          if (currentStep === sequence.length - 1) {
            // End of sequence reached, next step will be 0 (reset)
          }
        }
      }
    };

    runSequence();
    return () => {
      isActive = false;
    };
  }, []);

  useEffect(() => {
    const viewport = scrollRef.current;
    const transcript = transcriptRef.current;
    if (!viewport || !transcript) return;

    if (step === 0 || step >= 12) {
      viewport.scrollTo({ top: 0, behavior: 'auto' });
      return;
    }

    let animationFrame: number | undefined;
    const scrollToLatestOutput = () => {
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);

      animationFrame = requestAnimationFrame(() => {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: prefersReducedMotion ? 'auto' : 'smooth'
        });
        animationFrame = undefined;
      });
    };

    const resizeObserver = new ResizeObserver(scrollToLatestOutput);
    resizeObserver.observe(transcript);
    scrollToLatestOutput();

    return () => {
      resizeObserver.disconnect();
      if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    };
  }, [step, prefersReducedMotion]);

  return (
    <div className="w-full rounded-xl border border-neutral-800 bg-[#0a0a0a] font-mono text-sm shadow-2xl overflow-hidden text-neutral-400">
      {/* Terminal Header */}
      <div className="flex items-center px-4 py-3 border-b border-neutral-800 bg-neutral-900/80">
        <div className="flex gap-2">
          <div className="h-3 w-3 rounded-full bg-[#ff5f56]" />
          <div className="h-3 w-3 rounded-full bg-[#ffbd2e]" />
          <div className="h-3 w-3 rounded-full bg-[#27c93f]" />
        </div>
      </div>

      {/* Terminal Body */}
      <div
        ref={scrollRef}
        className="p-6 h-[380px] overflow-y-auto text-left"
      >
        <div ref={transcriptRef} className="flex w-full flex-col items-start gap-3">
        {step >= 1 && step < 12 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <span className="text-neutral-500">{'>'} </span>
            <span className="text-neutral-100 font-medium">
              <Typewriter text="explain authentication flow" speed={30} />
            </span>
          </motion.div>
        )}

        {step >= 2 && step < 12 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
            Searching index...
          </motion.div>
        )}

        {step >= 3 && step < 12 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-neutral-300"
          >
            <LoadingBar duration={500} />
          </motion.div>
        )}

        {step >= 4 && step < 12 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <span className="text-neutral-100">
              <Counter from={0} to={42} duration={600} suffix=" candidate files found" />
            </span>
          </motion.div>
        )}

        {step >= 5 && step < 12 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="mt-4 flex flex-col gap-1 overflow-hidden"
          >
            Expanding dependency graph...
          </motion.div>
        )}

        {step >= 6 && step < 12 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            className="flex flex-col gap-1 overflow-hidden"
          >
            <span className="text-neutral-300 pl-4">+ auth.ts</span>
            <span className="text-neutral-300 pl-4">+ jwt.ts</span>
            <span className="text-neutral-300 pl-4">+ middleware.ts</span>
            <span className="text-neutral-300 pl-4">+ session.ts</span>
          </motion.div>
        )}

        {step >= 7 && step < 12 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
            Ranking symbols...
            <div className="text-neutral-300 mt-1">
              {step >= 8 && <LoadingBar duration={800} />}
            </div>
          </motion.div>
        )}

        {step >= 9 && step < 12 && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-4">
            Compressing payload...
          </motion.div>
        )}

        {step >= 10 && step < 12 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-neutral-100 flex gap-2"
          >
            <span>Original payload: 28,000</span>
            <span>→</span>
            <span className="font-bold text-white flex gap-1">
              <Counter from={28000} to={1328} duration={1200} />
              <span>tokens</span>
            </span>
          </motion.div>
        )}

        {step >= 11 && step < 12 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="mt-4 flex items-center gap-2"
          >
            <span className="text-[#27c93f] font-bold">✓</span>
            <span className="text-white font-medium">Ready for LLM generation</span>
          </motion.div>
        )}

        <motion.div
          animate={{ opacity: [1, 0] }}
          transition={{ repeat: Infinity, duration: 0.8 }}
          className="w-2.5 h-4 bg-neutral-500 inline-block ml-1 mt-4"
        />
        </div>
      </div>
    </div>
  );
}
