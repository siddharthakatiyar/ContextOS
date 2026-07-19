/**
 * Helper to limit concurrency of async operations.
 * Returns a function that takes a factory returning a Promise.
 */
export function pLimit(concurrency: number) {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      queue.shift()!();
    }
  };

  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    activeCount++;
    try {
      const result = await fn();
      return result;
    } finally {
      next();
    }
  };

  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    if (activeCount < concurrency) {
      return run(fn);
    }
    return new Promise<T>((resolve, reject) => {
      queue.push(() => {
        run(fn).then(resolve).catch(reject);
      });
    });
  };

  return enqueue;
}
