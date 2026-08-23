import { describe, it, expect } from 'vitest';
import { computeBackoffMs } from '../../src/core/daemon/client.js';

describe('daemon client backoff', () => {
  it('grows exponentially from 100ms and caps at 8s', () => {
    expect(computeBackoffMs(0)).toBe(100);
    expect(computeBackoffMs(1)).toBe(200);
    expect(computeBackoffMs(2)).toBe(400);
    expect(computeBackoffMs(3)).toBe(800);
  });

  it('never exceeds the 8s cap regardless of attempt count', () => {
    for (let attempt = 0; attempt < 30; attempt++) {
      expect(computeBackoffMs(attempt)).toBeLessThanOrEqual(8_000);
    }
    expect(computeBackoffMs(30)).toBe(8_000);
  });
});
