/**
 * Simple concurrency limiter.
 * @param concurrency Maximum number of concurrent promises
 * @returns A function that wraps an async function to limit its concurrency
 */
export interface LimitFunction {
  <T>(fn: () => Promise<T>): Promise<T>;
  clearQueue: () => void;
}

export function pLimit(concurrency: number): LimitFunction {
  if (concurrency < 1) {
    throw new TypeError('Expected `concurrency` to be a number from 1 and up');
  }

  const queue: Array<() => void> = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      queue.shift()?.();
    }
  };

  const runner = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (activeCount >= concurrency) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }

    activeCount++;

    try {
      return await fn();
    } finally {
      next();
    }
  };

  runner.clearQueue = () => {
    queue.length = 0;
  };

  return runner;
}
