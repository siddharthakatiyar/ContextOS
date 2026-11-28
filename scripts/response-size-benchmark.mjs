#!/usr/bin/env node
// Measures complete MCP tool results; all state is isolated and fixtures are indexable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { encode } from 'gpt-tokenizer';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
const root = path.resolve(import.meta.dirname, '..');
const build = path.resolve(process.argv[2] ?? root);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-size-home-'));
process.env.HOME = process.env.USERPROFILE = home;
process.env.CONTEXTOS_EMBEDDINGS = '0';
process.env.CONTEXTOS_AUTO_PATCH = 'off';
fs.mkdirSync(path.join(root, 'scratch'), { recursive: true });
const fixture = fs.mkdtempSync(path.join(root, 'scratch', 'response-size-'));
const load = (name) => import(pathToFileURL(path.join(build, 'dist/src', name)).href);
const { WorkspaceRegistry } = await load('core/workspace/registry.js');
const { WorkspaceRuntime } = await load('core/workspace/runtime.js');
const { registerWorkspaceTools } = await load('mcp/workspace-tools.js');
const { GraphStore } = await load('core/knowledge/graph-store.js');
const registry = new WorkspaceRegistry();
const runtime = new WorkspaceRuntime(registry);
registry.ensureWorkspace('size');
const server = new McpServer({ name: 'size', version: '1' });
const client = new Client({ name: 'size', version: '1' });
try {
  const fixtures = [];
  for (let i = 0; i < 50; i++) {
    const dir = path.join(fixture, `repo-${i}`);
    fs.mkdirSync(dir);
    execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
    fs.writeFileSync(
      path.join(dir, 'payment.ts'),
      [1, 2]
        .filter((step) => i + step < 50)
        .map((step) => `import { payment${i + step} } from '../repo-${i + step}/payment.js';`)
        .join('\n') +
        `\nexport function payment${i}() { return ${
          [1, 2]
            .filter((step) => i + step < 50)
            .map((step) => `payment${i + step}()`)
            .join(' + ') || "'payment status'"
        }; }\n`
    );
    const source = registry.register(dir, { workspace: 'size' });
    await runtime.get(source).index();
    const row = runtime
      .get(source)
      .db.getInstance()
      .prepare('SELECT id FROM chunks WHERE symbol_name=? LIMIT 1')
      .get(`payment${i}`);
    fixtures.push({
      source: registry.resolve(source.repoId),
      ref: `contextos:${source.repoId}:chunk:${row.id}`
    });
  }
  registerWorkspaceTools(server, runtime, { cwd: path.join(fixture, 'repo-0'), workspace: 'size' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: { group: 'size', ...args } });
    if (result.isError) throw new Error(JSON.stringify(result));
    return result;
  };
  const scope = await call('ctx_scope', {});
  const generations = Object.fromEntries(
    fixtures.map(({ source }) => [source.repoId, source.generation])
  );
  const graph = new GraphStore({
    resolve: (id) => {
      const source = registry.resolve(id);
      return { source, db: runtime.get(source).db.getInstance() };
    }
  });
  try {
    for (let i = 0; i < fixtures.length; i++)
      for (const step of [1, 2]) {
        if (i + step >= fixtures.length) continue;
        graph.link(
          {
            source: fixtures[i].ref,
            target: fixtures[i + step].ref,
            type: 'imports',
            rationale: 'Fixture source imports and calls the target function by its relative path.',
            expectedGenerations: generations
          },
          fixtures.map((item) => item.source.repoId)
        );
      }
  } finally {
    graph.close();
  }
  const write = await call('ctx_link', {
    source: fixtures[0].ref,
    target: fixtures[1].ref,
    relationship: 'imports',
    rationale: 'Fixture source imports and calls the target function by its relative path.',
    expected_generations: generations
  });
  await call('ctx_remember', {
    content: 'Payment status is a user preference',
    provenance: 'user',
    scope: 'group'
  });
  const links = await call('ctx_links', {});
  const secondPage = !process.argv[2] ? await call('ctx_links', { offset: 50 }) : undefined;
  const context = await call('get_context', {
    prompt: 'payment status',
    max_tokens: 1500,
    tier: 'full'
  });
  const sizes = Object.fromEntries(
    Object.entries({ write, scope, links, context }).map(([key, result]) => [
      key,
      {
        chars: JSON.stringify(result).length,
        tokens: encode(JSON.stringify(result)).length,
        reportedTokens: result.structuredContent?.tokens
      }
    ])
  );
  if (!process.argv[2]) {
    assert.ok(sizes.write.tokens < 4000);
    assert.ok(sizes.scope.tokens < 20000);
    assert.ok(sizes.context.tokens <= 1500);
    assert.equal(sizes.context.reportedTokens, sizes.context.tokens);
    assert.equal(links.structuredContent.total, 97);
    assert.equal(links.structuredContent.links.length, 50);
    assert.equal(secondPage.structuredContent.links.length, 47);
    assert.equal(
      new Set(
        [...links.structuredContent.links, ...secondPage.structuredContent.links].map(
          (link) => link.id
        )
      ).size,
      97
    );
  }
  console.log(JSON.stringify(sizes, null, 2));
} finally {
  await client.close();
  await server.close();
  await runtime.close();
  registry.close();
  fs.rmSync(fixture, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
}
