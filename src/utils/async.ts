/**
 * Simple concurrency limiter.
 * @param concurrency Maximum number of concurrent promises
 * @returns A function that wraps an async function to limit its concurrency
 */
export function pLimit(concurrency: number) {
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

  return async <T>(fn: () => Promise<T>): Promise<T> => {
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
}
