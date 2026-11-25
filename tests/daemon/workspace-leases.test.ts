import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import Database from 'better-sqlite3';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';

let home: string;
let registry: WorkspaceRegistry;
const children: ChildProcess[] = [];
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-leases-'));
  registry = new WorkspaceRegistry(path.join(home, '.contextos'));
});
afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGTERM');
  registry.close();
  fs.rmSync(home, { recursive: true, force: true });
});
const candidate = () => ({
  pid: process.pid,
  token: crypto.randomUUID(),
  endpoint: path.join(home, 'candidate.sock'),
  protocol: 1
});
function stale(pid: number, endpoint = path.join(home, 'absent.sock')) {
  const owner = { ...candidate(), pid, endpoint };
  const db = new Database(path.join(home, '.contextos', 'registry.db'));
  db.prepare('INSERT OR REPLACE INTO indexing_leases VALUES (?,?)').run(
    'workspace:shared',
    JSON.stringify(owner)
  );
  db.close();
  return owner;
}
it('takes over a dead lease and an alive recycled PID without signaling it', async () => {
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  children.push(unrelated);
  await new Promise((resolve) => unrelated.once('spawn', resolve));
  stale(2147483647);
  let next = candidate();
  expect(await registry.takeWorkspaceLease(next)).toEqual(next);
  registry.releaseLease('workspace:shared', next.token);
  stale(unrelated.pid!);
  next = candidate();
  expect(await registry.takeWorkspaceLease(next)).toEqual(next);
  expect(() => process.kill(unrelated.pid!, 0)).not.toThrow();
});
it('honors a live lease when its socket answers status with the owning PID', async () => {
  const endpoint = path.join(home, 'status.sock');
  const server = net.createServer((socket) =>
    socket.once('data', () =>
      socket.end(JSON.stringify({ ok: true, pid: process.pid, version: 'test' }) + '\n')
    )
  );
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  try {
    const owner = stale(process.pid, endpoint);
    expect(await registry.takeWorkspaceLease(candidate())).toEqual(owner);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
it.each(['exit', 'uncaught'] as const)('releases the lease and files on %s', async (mode) => {
  const url = new URL('../../dist/src/core/workspace/daemon.js', import.meta.url).href;
  const code = `import { WorkspaceDaemon } from ${JSON.stringify(url)}; const daemon = new WorkspaceDaemon('default'); await daemon.start(); ${mode === 'exit' ? 'process.exit(9)' : "throw new Error('fixture crash')"};`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: home,
    env: { ...process.env, HOME: home }
  });
  children.push(child);
  child.stderr?.resume();
  await new Promise((resolve) => child.once('exit', resolve));
  expect(registry.lease('workspace:shared')).toBeUndefined();
  expect(fs.existsSync(path.join(home, '.contextos/runtime/daemon.pid'))).toBe(false);
  expect(fs.existsSync(path.join(home, '.contextos/runtime/daemon.sock'))).toBe(false);
});
it.each(['SIGTERM', 'SIGINT'] as const)('releases the lease and files on %s', async (signal) => {
  const child = spawn(
    process.execPath,
    [path.resolve('dist/bin/contextos.js'), 'daemon', 'start', '--keep-existing'],
    { cwd: home, env: { ...process.env, HOME: home } }
  );
  children.push(child);
  child.stderr?.resume();
  const pidFile = path.join(home, '.contextos/runtime/daemon.pid');
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(pidFile) && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(fs.existsSync(pidFile)).toBe(true);
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill(signal);
  await exited;
  expect(registry.lease('workspace:shared')).toBeUndefined();
  expect(fs.existsSync(pidFile)).toBe(false);
  expect(fs.existsSync(path.join(home, '.contextos/runtime/daemon.sock'))).toBe(false);
});
