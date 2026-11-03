import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ContextOSDaemon } from '../../src/core/daemon/daemon.js';
import { getPackageVersion } from '../../src/utils/version.js';
import { createUpgradeLock } from '../../src/core/updater/upgrade-lock.js';

class FakeControlSocket extends EventEmitter {
  public destroyed = false;
  public response: string | undefined;
  public responses: string[] = [];
  public setTimeout = vi.fn();

  public end(data?: string, _callback?: () => void): this {
    this.response = data;
    if (data !== undefined) this.responses.push(data);
    return this;
  }

  public destroy(): this {
    this.destroyed = true;
    return this;
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface TestDaemonState {
  startupReady: boolean;
  stopping: boolean;
  upgradeDrain?: Promise<void>;
  gcTimer?: NodeJS.Timeout;
  server: { listening: boolean; close: ReturnType<typeof vi.fn> };
  watcher: {
    close: ReturnType<typeof vi.fn>;
    waitForIdle: () => Promise<void>;
  };
  handleControlConnection(socket: FakeControlSocket): void;
  handleConnection(socket: FakeControlSocket): void;
}

function makeDaemon(
  startupReady: boolean,
  waitForIdle: () => Promise<void>
): { daemon: TestDaemonState; closeWatcher: ReturnType<typeof vi.fn> } {
  const closeWatcher = vi.fn().mockResolvedValue(undefined);
  const daemon = Object.create(ContextOSDaemon.prototype) as TestDaemonState;
  Object.assign(daemon, {
    startupReady,
    stopping: false,
    server: { listening: true, close: vi.fn() },
    watcher: { close: closeWatcher, waitForIdle },
    upgradeDrain: undefined,
    gcTimer: undefined
  });
  return { daemon, closeWatcher };
}

describe('daemon upgrade control', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  function useTemporaryHome(): void {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-upgrade-home-'));
    temporaryDirectories.push(home);
    vi.stubEnv('HOME', home);
  }

  function requestUpgrade(socket: FakeControlSocket, token: string): void {
    socket.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({ action: 'prepare-upgrade', token, expectedVersion: getPackageVersion() })}\n`
      )
    );
  }

  it('refuses a drain request until daemon startup has initialized its watcher', () => {
    useTemporaryHome();
    const lock = createUpgradeLock();
    try {
      const waitForIdle = vi.fn().mockResolvedValue(undefined);
      const { daemon, closeWatcher } = makeDaemon(false, waitForIdle);
      const socket = new FakeControlSocket();

      daemon.handleControlConnection(socket);
      requestUpgrade(socket, lock.token);

      expect(JSON.parse(socket.response!).ok).toBe(false);
      expect(JSON.parse(socket.response!).error).toContain('startup is still in progress');
      expect(closeWatcher).not.toHaveBeenCalled();
      expect(waitForIdle).not.toHaveBeenCalled();
    } finally {
      lock.release();
    }
  });

  it('keeps waiting for an active index drain beyond the request handshake timeout', async () => {
    useTemporaryHome();
    vi.useFakeTimers();
    const lock = createUpgradeLock();
    const idle = deferred<void>();
    try {
      const { daemon, closeWatcher } = makeDaemon(true, () => idle.promise);
      const socket = new FakeControlSocket();

      daemon.handleControlConnection(socket);
      requestUpgrade(socket, lock.token);
      await Promise.resolve();
      await Promise.resolve();

      expect(closeWatcher).toHaveBeenCalledOnce();
      expect(socket.response).toBeUndefined();

      await vi.advanceTimersByTimeAsync(31_000);
      expect(socket.response).toBeUndefined();

      idle.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(JSON.parse(socket.response!).ok).toBe(true);
    } finally {
      lock.release();
    }
  });

  it('ignores a late authenticated request after the handshake timeout and replies only once', async () => {
    useTemporaryHome();
    vi.useFakeTimers();
    const lock = createUpgradeLock();
    try {
      const waitForIdle = vi.fn().mockResolvedValue(undefined);
      const { daemon } = makeDaemon(true, waitForIdle);
      const socket = new FakeControlSocket();

      daemon.handleControlConnection(socket);
      await vi.advanceTimersByTimeAsync(30_000);
      const timeoutResponse = socket.response;

      requestUpgrade(socket, lock.token);
      await vi.advanceTimersByTimeAsync(0);

      expect(JSON.parse(timeoutResponse!).error).toContain('timed out');
      expect(socket.responses).toHaveLength(1);
      expect(waitForIdle).not.toHaveBeenCalled();
    } finally {
      lock.release();
    }
  });

  it('rejects new MCP sockets once draining has started', () => {
    const daemon = Object.create(ContextOSDaemon.prototype) as TestDaemonState;
    Object.assign(daemon, { stopping: true });
    const socket = new FakeControlSocket();

    daemon.handleConnection(socket);

    expect(socket.destroyed).toBe(true);
  });
});
