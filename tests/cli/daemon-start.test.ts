import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn()
}));
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemonCommand } from '../../src/cli/commands/daemon.js';
import { WorkspaceDaemon } from '../../src/core/workspace/daemon.js';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';
import { verifiedDaemonProcess } from '../../src/cli/utils/installation-setup.js';

vi.mock('../../src/cli/utils/installation-setup.js', () => ({ verifiedDaemonProcess: vi.fn() }));

let temporary: string;
let replies: Array<object | null>;
let signals: Array<string | number | undefined>;
let originalSignals: Record<string, Set<(...args: never[]) => unknown>>;
const previous = { ok: true, pid: 44321, version: '1.2.1', group: 'payments' };
beforeEach(() => {
  vi.mocked(verifiedDaemonProcess).mockClear();
  const start = daemonCommand.commands.find((command) => command.name() === 'start')!;
  for (const option of ['detach', 'background']) start.setOptionValue(option, false);
  fs.mkdirSync(path.resolve('scratch'), { recursive: true });
  temporary = fs.mkdtempSync(path.resolve('scratch', 'daemon-start-'));
  vi.spyOn(os, 'homedir').mockReturnValue(temporary);
  const registry = new WorkspaceRegistry();
  registry.ensureGroup('payments');
  registry.close();
  originalSignals = Object.fromEntries(
    ['SIGINT', 'SIGTERM'].map((signal) => [signal, new Set(process.listeners(signal))])
  );
  replies = [previous];
  signals = [];
  vi.mocked(verifiedDaemonProcess).mockReturnValue(true);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(WorkspaceDaemon.prototype, 'start').mockImplementation(async function (
    this: WorkspaceDaemon
  ) {
    await this.stop();
  });
  vi.spyOn(process, 'kill').mockImplementation(((_pid, signal) => {
    signals.push(signal);
    if (signal === 0) throw Object.assign(new Error('exited'), { code: 'ESRCH' });
    return true;
  }) as typeof process.kill);
  vi.spyOn(net, 'createConnection').mockImplementation((() => {
    const socket = new EventEmitter() as net.Socket;
    socket.setTimeout = vi.fn().mockReturnValue(socket);
    socket.destroy = vi.fn().mockReturnValue(socket);
    const reply = replies.shift();
    socket.write = vi.fn().mockImplementation(() => {
      queueMicrotask(() => socket.emit('data', Buffer.from(JSON.stringify(reply) + '\n')));
      return true;
    });
    queueMicrotask(() =>
      reply ? socket.emit('connect') : socket.emit('error', new Error('not running'))
    );
    return socket;
  }) as typeof net.createConnection);
});
afterEach(() => {
  for (const signal of ['SIGINT', 'SIGTERM'])
    for (const listener of process.listeners(signal))
      if (!originalSignals[signal].has(listener)) process.removeListener(signal, listener);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
  fs.rmSync(temporary, { recursive: true, force: true });
});

describe('daemon start replacement', () => {
  it('gracefully replaces an existing daemon before foreground startup', async () => {
    await daemonCommand.parseAsync(['node', 'contextos', 'start', '--group', 'payments']);
    expect(signals).toEqual(['SIGTERM', 0]);
    expect(verifiedDaemonProcess).toHaveBeenCalledWith(previous.pid);
    expect(WorkspaceDaemon.prototype.start).toHaveBeenCalledOnce();
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Replaced previous ContextOS daemon (PID 44321, version 1.2.1')
    );
  });

  it('re-verifies identity and kills a daemon that does not gracefully exit', async () => {
    vi.useFakeTimers();
    let killed = false;
    vi.mocked(process.kill).mockImplementation(((_pid, signal) => {
      signals.push(signal);
      if (signal === 'SIGKILL') killed = true;
      if (signal === 0 && killed) throw Object.assign(new Error('exited'), { code: 'ESRCH' });
      return true;
    }) as typeof process.kill);
    const starting = daemonCommand.parseAsync([
      'node',
      'contextos',
      'start',
      '--group',
      'payments'
    ]);
    await vi.runAllTimersAsync();
    await starting;
    expect(signals.filter((signal) => signal !== 0)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(verifiedDaemonProcess).toHaveBeenCalledTimes(2);
    expect(WorkspaceDaemon.prototype.start).toHaveBeenCalledOnce();
  });

  it('refuses escalation if process identity changes during graceful shutdown', async () => {
    vi.useFakeTimers();
    vi.mocked(verifiedDaemonProcess).mockReturnValueOnce(true).mockReturnValue(false);
    vi.mocked(process.kill).mockImplementation(((_pid, signal) => {
      signals.push(signal);
      return true;
    }) as typeof process.kill);
    const starting = daemonCommand.parseAsync([
      'node',
      'contextos',
      'start',
      '--group',
      'payments'
    ]);
    const rejected = expect(starting).rejects.toThrow('Cannot verify ContextOS daemon PID');
    await vi.runAllTimersAsync();
    await rejected;
    expect(signals.filter((signal) => signal !== 0)).toEqual(['SIGTERM']);
    expect(WorkspaceDaemon.prototype.start).not.toHaveBeenCalled();
  });

  it('does not signal an unverified PID or start another daemon', async () => {
    vi.mocked(verifiedDaemonProcess).mockReturnValue(false);
    await expect(
      daemonCommand.parseAsync(['node', 'contextos', 'start', '--group', 'payments'])
    ).rejects.toThrow('Cannot verify ContextOS daemon PID');
    expect(signals).toEqual([]);
    expect(WorkspaceDaemon.prototype.start).not.toHaveBeenCalled();
  });

  it.each(['--detach', '--background'])(
    'replaces the previous daemon with %s and accepts readiness from a re-executed child',
    async (option) => {
      replies.push({ ...previous, pid: 55332, version: '1.2.2' });
      const child = Object.assign(new EventEmitter(), {
        pid: 55331,
        exitCode: null,
        signalCode: null,
        unref: vi.fn(),
        kill: vi.fn()
      });
      const spawnMock = vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
      await daemonCommand.parseAsync(['node', 'contextos', 'start', '--group', 'payments', option]);
      expect(signals).toEqual(['SIGTERM', 0]);
      expect(spawnMock).toHaveBeenCalledOnce();
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('RUNNING (PID 55332, version 1.2.2, group payments)')
      );
      expect(child.kill).not.toHaveBeenCalled();
    }
  );

  it('starts normally when there is no existing daemon', async () => {
    replies = [null];
    await daemonCommand.parseAsync(['node', 'contextos', 'start', '--group', 'payments']);
    expect(signals).toEqual([]);
    expect(WorkspaceDaemon.prototype.start).toHaveBeenCalledOnce();
  });
});
