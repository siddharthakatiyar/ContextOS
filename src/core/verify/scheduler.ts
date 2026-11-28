import { Worker } from 'node:worker_threads';

export const DEFAULT_VERIFY_INTERVAL_MS = 6 * 60 * 60 * 1000;
export function verificationInterval(env = process.env): number {
  const value = env.CONTEXTOS_VERIFY_INTERVAL_MS;
  if (value === undefined) return DEFAULT_VERIFY_INTERVAL_MS;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_VERIFY_INTERVAL_MS;
}

/** Coalesce generation changes without running validation in an index callback. */
export function createSweepScheduler(options: {
  interval: number;
  generations: () => { viewId: string; generation: number; ready: boolean }[];
  run: (viewIds?: string[]) => Promise<unknown>;
  onError?: (error: unknown) => void;
  pollMs?: number;
  debounceMs?: number;
  initialSweep?: boolean;
}) {
  let stopped = false;
  let running = false;
  let full = options.initialSweep ?? false;
  const pending = new Set<string>();
  const seen = new Map<string, number>();
  let debounce: NodeJS.Timeout | undefined;
  const launch = async () => {
    if (running || stopped || (!full && !pending.size)) return;
    running = true;
    const ids = full ? undefined : [...pending];
    full = false;
    pending.clear();
    try {
      await options.run(ids);
    } catch (error) {
      options.onError?.(error);
    } finally {
      running = false;
      if (!stopped && (full || pending.size)) schedule();
    }
  };
  const schedule = (reset = true) => {
    if (debounce && !reset) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      void launch();
    }, options.debounceMs ?? 1000);
    debounce.unref();
  };
  let initialized = false;
  const poll = () => {
    try {
      for (const source of options.generations()) {
        if (!source.ready) {
          if (!seen.has(source.viewId)) seen.set(source.viewId, source.generation);
          continue;
        }
        const previous = seen.get(source.viewId);
        seen.set(source.viewId, source.generation);
        if (
          (initialized && previous === undefined) ||
          (previous !== undefined && previous !== source.generation)
        ) {
          pending.add(source.viewId);
          schedule();
        }
      }
    } catch (error) {
      options.onError?.(error);
    }
    initialized = true;
  };
  if (options.interval === 0)
    return {
      stop() {
        stopped = true;
      }
    };
  poll();
  if (full) schedule();
  const polling = setInterval(poll, options.pollMs ?? 1000);
  // Long intervals exceed Node's timeout range; account for elapsed time instead.
  let lastFull = Date.now();
  const periodic = setInterval(
    () => {
      if (Date.now() - lastFull < options.interval) return;
      lastFull = Date.now();
      full = true;
      schedule(false);
    },
    Math.min(options.interval, 60_000)
  );
  polling.unref();
  periodic.unref();
  return {
    stop() {
      stopped = true;
      clearInterval(polling);
      clearInterval(periodic);
      if (debounce) clearTimeout(debounce);
    }
  };
}

/** The daemon only creates a worker: SQLite scans and hashing never run on its
 * indexing/handshake event loop. No lease is acquired or indexing request made.
 */
export function startVerificationScheduler(
  home: string,
  viewIds?: string[]
): { stop: () => Promise<void> } {
  if (verificationInterval() === 0) return { async stop() {} };
  const worker = new Worker(new URL('./worker.js', import.meta.url), {
    workerData: { home, viewIds }
  });
  worker.unref();
  worker.on('error', (error) =>
    console.error(
      `Knowledge verification sweep failed: ${error instanceof Error ? error.message : String(error)}`
    )
  );
  return {
    async stop() {
      await worker.terminate();
    }
  };
}
