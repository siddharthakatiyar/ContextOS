import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createSweepScheduler,
  DEFAULT_VERIFY_INTERVAL_MS,
  verificationInterval
} from '../../src/core/verify/scheduler.js';

afterEach(() => vi.useRealTimers());

describe('low priority verification scheduler', () => {
  it('uses six hours by default, accepts zero and rejects malformed intervals', () => {
    expect(verificationInterval({})).toBe(DEFAULT_VERIFY_INTERVAL_MS);
    expect(verificationInterval({ CONTEXTOS_VERIFY_INTERVAL_MS: '0' })).toBe(0);
    expect(verificationInterval({ CONTEXTOS_VERIFY_INTERVAL_MS: '120' })).toBe(120);
    for (const value of ['-1', 'NaN', '1.5', 'Infinity'])
      expect(verificationInterval({ CONTEXTOS_VERIFY_INTERVAL_MS: value })).toBe(
        DEFAULT_VERIFY_INTERVAL_MS
      );
  });
  it('does no work when disabled and waits for the first periodic interval', async () => {
    vi.useFakeTimers();
    const generations = vi.fn(() => []);
    const run = vi.fn(async () => {});
    const disabled = createSweepScheduler({ interval: 0, generations, run });
    await vi.advanceTimersByTimeAsync(DEFAULT_VERIFY_INTERVAL_MS);
    expect(generations).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    disabled.stop();
    const scheduler = createSweepScheduler({ interval: 100, generations, run, debounceMs: 10 });
    await vi.advanceTimersByTimeAsync(99);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11);
    expect(run).toHaveBeenCalledWith(undefined);
    scheduler.stop();
  });
  it('debounces changed generations, waits until ready, and scopes affected views', async () => {
    vi.useFakeTimers();
    let generation = 1;
    let ready = true;
    const run = vi.fn(async () => {});
    const scheduler = createSweepScheduler({
      interval: 10_000,
      pollMs: 10,
      debounceMs: 30,
      generations: () => [{ viewId: 'a', generation, ready }],
      run
    });
    generation = 2;
    ready = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(run).not.toHaveBeenCalled();
    ready = true;
    await vi.advanceTimersByTimeAsync(10);
    generation = 3;
    await vi.advanceTimersByTimeAsync(20);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledExactlyOnceWith(['a']);
    scheduler.stop();
    generation = 4;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('serializes sweeps and isolates failures, retaining changes during an active sweep', async () => {
    vi.useFakeTimers();
    let generation = 1;
    let release!: () => void;
    const onError = vi.fn();
    const run = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      )
      .mockRejectedValueOnce(new Error('busy'))
      .mockResolvedValue(undefined);
    const scheduler = createSweepScheduler({
      interval: 10_000,
      pollMs: 10,
      debounceMs: 10,
      generations: () => [{ viewId: 'a', generation, ready: true }],
      run,
      onError
    });
    generation = 2;
    await vi.advanceTimersByTimeAsync(20);
    expect(run).toHaveBeenCalledTimes(1);
    generation = 3;
    await vi.advanceTimersByTimeAsync(50);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
    generation = 4;
    await vi.advanceTimersByTimeAsync(30);
    expect(run).toHaveBeenCalledTimes(3);
    scheduler.stop();
  });
  it('does not starve periodic sweeps when the interval is shorter than debounce', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const scheduler = createSweepScheduler({
      interval: 10,
      debounceMs: 100,
      generations: () => [],
      run
    });
    await vi.advanceTimersByTimeAsync(110);
    expect(run).toHaveBeenCalledExactlyOnceWith(undefined);
    scheduler.stop();
  });
  it('can queue an initial asynchronous sweep to cover indexing completed before worker startup', async () => {
    vi.useFakeTimers();
    const run = vi.fn(async () => {});
    const scheduler = createSweepScheduler({
      interval: 10_000,
      initialSweep: true,
      debounceMs: 10,
      generations: () => [],
      run
    });
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(run).toHaveBeenCalledExactlyOnceWith(undefined);
    scheduler.stop();
  });
});
