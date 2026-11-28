import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { workspaceToolCatalog } from '../../src/mcp/tool-catalog.js';
import { MCP_SERVER_INSTRUCTIONS } from '../../src/mcp/instructions.js';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';

let home: string;
let child: ChildProcessWithoutNullStreams | undefined;
afterEach(() => {
  child?.kill('SIGTERM');
  child = undefined;
  if (home) {
    try {
      execFileSync(process.execPath, ['dist/bin/contextos.js', 'daemon', 'stop'], {
        env: { ...process.env, HOME: home },
        stdio: 'ignore',
        timeout: 10000
      });
    } catch {
      /* no daemon */
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});
it('builds both tool catalogs and instructions from the real daemon registrations', async () => {
  const catalog = JSON.parse(fs.readFileSync('dist/src/mcp/tool-catalog.json', 'utf8'));
  expect(catalog.instructions).toBe(MCP_SERVER_INSTRUCTIONS);
  expect(catalog.standard).toEqual(await workspaceToolCatalog());
  expect(catalog.legacy).toEqual(await workspaceToolCatalog(true));
  for (const tools of [catalog.standard.tools, catalog.legacy.tools]) {
    const links = tools.find((tool: { name: string }) => tool.name === 'ctx_links');
    const trace = tools.find((tool: { name: string }) => tool.name === 'ctx_trace');
    expect(links.inputSchema.properties.limit.default).toBe(20);
    expect(links.inputSchema.properties.verbose.default).toBe(false);
    expect(trace.inputSchema.properties.verbose.default).toBe(false);
  }
});
it('answers discover, initialize, ping and tools/list locally while daemon startup is slow', async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-handshake-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const root = path.join(home, 'fixture');
  fs.mkdirSync(root);
  const registry = new WorkspaceRegistry();
  registry.register(root);
  registry.close();
  const start = performance.now();
  child = spawn(process.execPath, [path.resolve('dist/bin/contextos.js'), 'serve'], {
    cwd: root,
    env: {
      ...process.env,
      HOME: home,
      CONTEXTOS_REPO_ROOT: root,
      CONTEXTOS_SKIP_SETUP: '1',
      CONTEXTOS_TEST_DAEMON_STARTUP_DELAY_MS: '2000'
    }
  });
  let buffer = '';
  const pending = new Map<string | number, (reply: Record<string, unknown>) => void>();
  child.stderr.resume();
  child.stdout.on('data', (data) => {
    buffer += data.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const reply = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(reply.id)?.(reply);
    }
  });
  const request = (id: string | number, method: string, params = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`${method} timed out`)), 10000);
      pending.set(id, (reply) => {
        clearTimeout(timeout);
        resolve(reply);
      });
      child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  expect(
    await request('server-discover-probe-1', 'server/discover', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' }
    })
  ).toMatchObject({ error: { code: -32601 } });
  expect(
    await request(1, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' }
    })
  ).toHaveProperty('result.serverInfo.name', 'contextos');
  expect(performance.now() - start).toBeLessThan(1000);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  expect(await request(2, 'ping')).toMatchObject({ result: {} });
  expect(await request(3, 'tools/list')).toHaveProperty('result.tools');
  expect(fs.existsSync(path.join(home, '.contextos', 'runtime', 'daemon.pid'))).toBe(false);
  const toolStart = performance.now();
  expect(await request(4, 'tools/call', { name: 'ctx_scope', arguments: {} })).toHaveProperty(
    'result.content'
  );
  expect(performance.now() - toolStart).toBeGreaterThan(2000);
  // Compare the static frontend catalog with the running daemon's actual list.
  const socket = net.createConnection(path.join(home, '.contextos/runtime/daemon.sock'));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(JSON.stringify({ workspaceId: 'default', cwd: root }) + '\n');
  const daemonClient = new Client({ name: 'parity', version: '1' });
  try {
    await daemonClient.connect(new StdioServerTransport(socket, socket));
    const catalog = JSON.parse(fs.readFileSync('dist/src/mcp/tool-catalog.json', 'utf8'));
    expect(await daemonClient.listTools()).toEqual(catalog.standard);
  } finally {
    await daemonClient.close();
    socket.destroy();
  }
}, 15000);
it('returns a clear tool error when the backend cannot initialize before its deadline', async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-handshake-'));
  child = spawn(process.execPath, [path.resolve('dist/bin/contextos.js'), 'serve'], {
    cwd: home,
    env: {
      ...process.env,
      HOME: home,
      CONTEXTOS_REPO_ROOT: home,
      CONTEXTOS_DAEMON_CONNECT_TIMEOUT_MS: '100',
      CONTEXTOS_SKIP_SETUP: '1'
    }
  });
  child.stderr.resume();
  let output = '';
  child.stdout.on('data', (data) => {
    output += data.toString();
  });
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' }
      }
    }) + '\n'
  );
  await vi.waitFor(() => expect(output).toContain('serverInfo'), { timeout: 5000 });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ctx_scope', arguments: {} }
    }) + '\n'
  );
  await vi.waitFor(() => expect(output).toContain('ContextOS daemon unavailable'), {
    timeout: 5000
  });
  expect(output).toContain('"isError":true');
});

it('fails an immediate tool call after daemon SIGKILL promptly and reconnects on the next call', async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-killed-daemon-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  const root = path.join(home, 'fixture');
  fs.mkdirSync(root);
  const registry = new WorkspaceRegistry();
  registry.register(root);
  registry.close();
  child = spawn(
    process.execPath,
    [path.resolve('dist/bin/contextos.js'), 'serve', '--group', 'default'],
    {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        CONTEXTOS_REPO_ROOT: root,
        CONTEXTOS_SKIP_SETUP: '1',
        CONTEXTOS_EMBEDDINGS: '0'
      }
    }
  );
  child.stderr.resume();
  let buffer = '';
  const pending = new Map<number, (value: Record<string, unknown>) => void>();
  child.stdout.on('data', (data) => {
    buffer += data.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const reply = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      pending.get(reply.id)?.(reply);
    }
  });
  const request = (id: number, method: string, params = {}, timeoutMs = 10000) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} lost its reply`)), timeoutMs);
      pending.set(id, (value) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(value);
      });
      child!.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  await request(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'kill-test', version: '1' }
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  expect(await request(2, 'tools/call', { name: 'ctx_scope', arguments: {} })).toHaveProperty(
    'result.content'
  );
  const pidText = fs.readFileSync(path.join(home, '.contextos/runtime/daemon.pid'), 'utf8');
  const pid = Number(pidText.trim());
  const started = performance.now();
  process.kill(pid, 'SIGKILL');
  // No yield between kill and send: exercise the close/write race.
  const failed = await request(3, 'tools/call', { name: 'ctx_scope', arguments: {} }, 3000);
  expect(performance.now() - started).toBeLessThan(3000);
  expect(JSON.stringify(failed)).toContain('daemon unavailable');
  expect(await request(4, 'tools/call', { name: 'ctx_scope', arguments: {} })).toHaveProperty(
    'result.content'
  );
}, 20000);
