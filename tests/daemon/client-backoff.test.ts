import { describe, it, expect } from 'vitest';
import { computeBackoffMs, ReconnectBackoff } from '../../src/core/daemon/client.js';

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

  it('persists attempts across successive socket generations and enforces the cap', () => {
    const backoff = new ReconnectBackoff();
    expect(backoff.nextDelay()).toBe(200);
    expect(backoff.nextDelay()).toBe(400);
    expect(backoff.getAttempts()).toBe(2);

    for (let attempt = 3; attempt <= 10; attempt++) {
      expect(backoff.nextDelay()).not.toBeNull();
    }
    expect(backoff.nextDelay()).toBeNull();
  });

  it('resets only when the caller marks a connection healthy', () => {
    const backoff = new ReconnectBackoff();
    backoff.nextDelay();
    backoff.nextDelay();
    backoff.reset();
    expect(backoff.getAttempts()).toBe(0);
    expect(backoff.nextDelay()).toBe(200);
  });
});
