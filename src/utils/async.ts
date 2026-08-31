/**
 * Simple concurrency limiter.
 * @param concurrency Maximum number of concurrent promises
 * @returns A function that wraps an async function to limit its concurrency
 */
export interface LimitFunction {
  <T>(fn: () => Promise<T>): Promise<T>;
  clearQueue: () => void;
}

interface QueueEntry {
  cancelled: boolean;
  resolve: () => void;
}

export function pLimit(concurrency: number): LimitFunction {
  if (concurrency < 1) {
    throw new TypeError('Expected `concurrency` to be a number from 1 and up');
  }

  const queue: QueueEntry[] = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      queue.shift()!.resolve();
    }
  };

  const runner = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (activeCount >= concurrency) {
      const entry: QueueEntry = { cancelled: false, resolve: () => {} };
      const gate = new Promise<void>((resolve) => {
        entry.resolve = resolve;
      });
      queue.push(entry);
      await gate;
      if (entry.cancelled) {
        // Abandoned via clearQueue(): settle without executing so callers'
        // promises never hang and active bookkeeping stays consistent.
        return undefined as T;
      }
    }

    activeCount++;

    try {
      return await fn();
    } finally {
      next();
    }
  };

  runner.clearQueue = () => {
    while (queue.length > 0) {
      const entry = queue.shift()!;
      entry.cancelled = true;
      entry.resolve();
    }
  };

  return runner;
}
