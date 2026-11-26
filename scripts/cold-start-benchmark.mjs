#!/usr/bin/env node
// Usage: node scripts/cold-start-benchmark.mjs [--build-dir DIR] [--repos 50]
// All registry, Git and daemon state lives in an isolated HOME under scratch/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const args = process.argv.slice(2);
const option = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback);
const root = path.resolve(import.meta.dirname, '..');
const build = path.resolve(option('--build-dir', root));
const count = Number(option('--repos', '50'));
fs.mkdirSync(path.join(root, 'scratch'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'scratch', 'cold-bench-'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-cold-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CONTEXTOS_EMBEDDINGS = '0';
process.env.CONTEXTOS_AUTO_PATCH = 'off';
process.env.CONTEXTOS_DAEMON_IDLE_MS = '60000';
process.env.GIT_CONFIG_NOSYSTEM = '1';
const load = (file) => import(pathToFileURL(path.join(build, 'dist/src', file)).href);
const { WorkspaceRegistry } = await load('core/workspace/registry.js');
const { WorkspaceRuntime } = await load('core/workspace/runtime.js');
const registry = new WorkspaceRegistry();
const runtime = new WorkspaceRuntime(registry);
registry.ensureWorkspace('cold');
const cli = path.join(build, 'dist/bin/contextos.js');
const clients = [];
const git = (cwd, ...values) => execFileSync('git', ['-C', cwd, ...values], { stdio: 'ignore' });
const output = console.log;
console.log = (...values) => process.stderr.write(values.join(' ') + '\n');
let firstRoot;
async function connect() {
  const start = performance.now();
  const child = spawn(process.execPath, [cli, 'serve', '--group', 'cold'], {
    cwd: firstRoot,
    env: { ...process.env, CONTEXTOS_REPO_ROOT: firstRoot },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  clients.push(child);
  let buffer = '';
  const pending = new Map();
  child.stderr.on('data', () => {});
  child.stdout.on('data', (data) => {
    buffer += data.toString();
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        const reply = JSON.parse(line);
        pending.get(reply.id)?.(reply);
      } catch {
        /* non-RPC log */
      }
    }
  });
  const request = (id, method, params = {}) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 120000);
      pending.set(id, (reply) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(reply);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  await request(1, 'initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'benchmark', version: '1' }
  });
  const initializeMs = performance.now() - start;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const call = await request(2, 'tools/call', { name: 'ctx_scope', arguments: {} });
  if (call.error || call.result?.isError) throw new Error(JSON.stringify(call));
  return { initializeMs, firstToolMs: performance.now() - start };
}
try {
  for (let i = 0; i < count; i++) {
    const repo = path.join(fixture, `repo-${i}`);
    fs.mkdirSync(repo);
    firstRoot ??= repo;
    git(repo, 'init', '-b', 'main');
    for (let j = 0; j < 24; j++)
      fs.writeFileSync(
        path.join(repo, `module-${j}.ts`),
        `export function value${j}() { return ${i + j}; }\n`
      );
    git(repo, 'add', '.');
    git(
      repo,
      '-c',
      'user.name=Benchmark',
      '-c',
      'user.email=bench@example.invalid',
      'commit',
      '-m',
      'fixture'
    );
    git(repo, 'worktree', 'add', '-b', 'feature', `${repo}-feature`);
    registry.register(repo, { workspace: 'cold' });
    for (const source of registry.views(registry.resolve(repo).projectId).filter((v) => v.active))
      await runtime.get(source).index();
    if ((i + 1) % 10 === 0) process.stderr.write(`Prepared ${i + 1}/${count} repositories\n`);
  }
  // Finish the normal install/setup migration before measuring daemon cold start.
  const { upgradeExistingProjects } = await load('cli/utils/installation-setup.js');
  await upgradeExistingProjects({ cwd: firstRoot, log: () => {} });
  await runtime.close();
  registry.close();
  const first = await connect();
  const second = await connect();
  output(
    JSON.stringify(
      {
        repos: count,
        views: count * 2,
        ...first,
        secondInitializeMs: second.initializeMs,
        secondClientMs: second.firstToolMs
      },
      null,
      2
    )
  );
} finally {
  for (const child of clients) child.kill('SIGTERM');
  try {
    execFileSync(process.execPath, [cli, 'daemon', 'stop'], {
      env: { ...process.env, CONTEXTOS_REPO_ROOT: firstRoot },
      stdio: 'ignore',
      timeout: 15000
    });
  } catch {
    /* cleanup */
  }
  await runtime.close().catch(() => {});
  try {
    registry.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
