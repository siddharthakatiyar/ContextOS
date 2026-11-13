import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

describe('built CLI and workspace daemon', () => {
  it('registers four repositories and serves two independent MCP clients through one daemon', async () => {
    const root = fs.mkdtempSync(
      path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'cwc-')
    );
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const cli = path.resolve('dist/bin/contextos.js');
    const env = { ...process.env, HOME: home, USERPROFILE: home, CONTEXTOS_EMBEDDINGS: '0' };
    const run = (args: string[], cwd = root) =>
      execFileSync(process.execPath, [cli, ...args], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    const clients: Client[] = [];
    let watcher: ReturnType<typeof spawn> | undefined;
    try {
      for (const name of ['backend', 'frontend', 'shared-types', 'infrastructure']) {
        const repo = path.join(root, name);
        fs.cpSync(path.resolve('tests/fixtures/workspace', name), repo, { recursive: true });
        run(['repo', 'add', repo]);
      }
      const list = JSON.parse(run(['repo', 'list', '--json']));
      expect(list.repositories).toHaveLength(4);
      expect(list.ready).toBe(true);
      const query = JSON.parse(
        run([
          'query',
          'Where is payment status defined, processed, and displayed?',
          '--all-repos',
          '--json',
          '--max-tokens',
          '4000'
        ])
      );
      for (const name of ['backend', 'frontend', 'shared-types'])
        expect(query.context).toContain(name + '/payment.ts');
      expect(() => run(['query', 'payment status'])).toThrow();
      const connect = async (repo: string) => {
        const client = new Client({ name: 'cli-test', version: '1' });
        clients.push(client);
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [cli, 'serve', '--workspace', 'default', '--repo', repo],
          cwd: root,
          env: env as Record<string, string>,
          stderr: 'pipe'
        });
        await client.connect(transport);
        return client;
      };
      const [backend, frontend] = await Promise.all([connect('backend'), connect('frontend')]);
      const tools = await backend.listTools();
      expect(tools.tools.some((t) => t.name === 'contextos_status')).toBe(true);
      const own = await frontend.callTool({
        name: 'get_context',
        arguments: { prompt: 'displayPaymentStatus', tier: 'full' }
      });
      expect(JSON.stringify(own.content)).toContain('frontend/payment.ts');
      const all = await backend.callTool({
        name: 'get_context',
        arguments: { prompt: 'payment status', all_repos: true, tier: 'full', max_tokens: 4000 }
      });
      expect(
        (all.structuredContent as { scope: { repoIds: string[] } }).scope.repoIds
      ).toHaveLength(4);
      const savedFact = await backend.callTool({
        name: 'ctx_remember',
        arguments: {
          type: 'cross_session_fact',
          content: 'PaymentMemorySurvivesReindex',
          provenance: 'user'
        }
      });
      expect(savedFact.isError).not.toBe(true);
      run(['reindex', '--repo', 'backend']);
      const memory = await backend.callTool({
        name: 'get_context',
        arguments: { prompt: 'PaymentMemorySurvivesReindex', tier: 'full' }
      });
      expect(JSON.stringify(memory.content)).toContain('PaymentMemorySurvivesReindex');
      run(['repo', 'remove', 'frontend']);
      const removed = await frontend.callTool({
        name: 'get_context',
        arguments: { prompt: 'payment status' }
      });
      expect(removed.isError).toBe(true);
      expect(
        fs.existsSync(
          list.repositories.find((view: { name: string }) => view.name === 'frontend').dbPath
        )
      ).toBe(true);
      expect(fs.existsSync(path.join(root, 'frontend', '.contextos'))).toBe(false);
      run(['repo', 'add', path.join(root, 'frontend')]);
      const restored = await frontend.callTool({
        name: 'get_context',
        arguments: { prompt: 'displayPaymentStatus', tier: 'full' }
      });
      expect(restored.isError).not.toBe(true);
      expect(JSON.stringify(restored.content)).toContain('frontend/payment.ts');
      watcher = spawn(process.execPath, [cli, 'watch', '-w', 'legacy-label'], {
        cwd: path.join(root, 'backend'),
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('Legacy watch did not start')), 10_000);
        watcher!.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        watcher!.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`Watch exited early (${code})`));
        });
        watcher!.stdout!.on('data', (data) => {
          output += data.toString();
          if (output.includes('Watching: backend')) {
            clearTimeout(timer);
            resolve();
          }
        });
      });
      expect(watcher.exitCode).toBeNull();
      const stopped = once(watcher, 'exit');
      watcher.kill('SIGTERM');
      await stopped;
      expect(
        JSON.parse(run(['repo', 'list', '--workspace', 'legacy-label', '--json'])).repositories
      ).toHaveLength(1);
    } finally {
      if (watcher && watcher.exitCode === null && watcher.signalCode === null) {
        const stopped = once(watcher, 'exit');
        watcher.kill('SIGTERM');
        await stopped;
      }
      for (const client of clients) await client.close();
      try {
        run(['daemon', 'stop', '--workspace', 'default']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  }, 60_000);
});
