import { describe, it, expect } from 'vitest';
import { pLimit } from '../../src/utils/concurrency.js';

describe('pLimit', () => {
  it('limits concurrency to the specified amount', async () => {
    const limit = pLimit(2);
    let activeCount = 0;
    let maxActiveCount = 0;

    const task = async (id: number, delayMs: number) => {
      activeCount++;
      if (activeCount > maxActiveCount) {
        maxActiveCount = activeCount;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      activeCount--;
      return id;
    };

    const promises = [
      limit(() => task(1, 10)),
      limit(() => task(2, 20)),
      limit(() => task(3, 10)),
      limit(() => task(4, 10)),
      limit(() => task(5, 10))
    ];

    const results = await Promise.all(promises);
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(maxActiveCount).toBe(2);
  });
});
