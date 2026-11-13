import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { waitForDaemonSocket } from '../../src/core/daemon/client.js';

const roots: string[] = [];
const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('waits for a daemon that binds after the previous startup retry window', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-start-'));
  roots.push(root);
  const socketPath = path.join(root, 'daemon.sock');
  const server = net.createServer((socket) => socket.end());
  servers.push(server);
  const listening = new Promise<void>((resolve) =>
    setTimeout(() => server.listen(socketPath, resolve), 1600)
  );
  const socket = await waitForDaemonSocket(socketPath, { timeoutMs: 5000, intervalMs: 50 });
  await listening;
  expect(socket.connecting).toBe(false);
  socket.destroy();
}, 7000);
it('fails with the socket path and a diagnostic when startup times out', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-start-'));
  roots.push(root);
  const socketPath = path.join(root, 'missing.sock');
  await expect(waitForDaemonSocket(socketPath, { timeoutMs: 150, intervalMs: 20 })).rejects.toThrow(
    /did not become ready.*missing\.sock.*daemon status/s
  );
});
