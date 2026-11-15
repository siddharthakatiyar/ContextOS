#!/usr/bin/env node
// Exercise the installable artifact, not the checkout's node_modules or CLI.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const checkout = path.resolve(import.meta.dirname, '..');
const archive = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2] && fs.existsSync(archive), 'Pass the packed release tarball');
const previousArchive = process.argv[4] ? path.resolve(process.argv[4]) : undefined;
if (previousArchive)
  assert.ok(fs.existsSync(previousArchive), 'Previous package tarball is missing');
const version = JSON.parse(fs.readFileSync(path.join(checkout, 'package.json'))).version;
const output = path.resolve(
  process.argv[3] ?? path.join(os.tmpdir(), `contextos-${version}-package-test.json`)
);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-release-')));
const home = path.join(root, 'home');
const prefix = path.join(root, 'global');
const legacy = path.join(root, 'legacy');
const fakeBin = path.join(root, 'agents');
for (const directory of [home, legacy, fakeBin]) fs.mkdirSync(directory);
const env = { ...process.env };
for (const key of [
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'COPILOT_HOME',
  'CONTEXTOS_REPO_ROOT',
  'CONTEXTOS_MCP_COMMAND',
  'CONTEXTOS_MCP_ARGS',
  'CONTEXTOS_UPGRADE_TOKEN'
])
  delete env[key];
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  CONTEXTOS_EMBEDDINGS: '0',
  CONTEXTOS_SKIP_SETUP: '0',
  CONTEXTOS_GLOBAL_INSTRUCTIONS: '1',
  CONTEXTOS_AUTO_PATCH_REEXEC: '1',
  ONNXRUNTIME_NODE_INSTALL: 'skip',
  PATH: [path.join(prefix, 'bin'), fakeBin, env.PATH].join(path.delimiter)
});
for (const agent of [
  'codex',
  'claude',
  'grok',
  'opencode',
  'gemini',
  'agy',
  'amp',
  'copilot',
  'windsurf',
  'cursor'
])
  fs.writeFileSync(path.join(fakeBin, agent), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const results = [];
const clients = [];
const startedAt = new Date().toISOString();
let cli;
const run = (command, args, cwd = legacy, timeout = 60_000) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
const command = (args, cwd) => run(process.execPath, [cli, ...args], cwd);
const json = (args, cwd) => JSON.parse(command(args, cwd));
const git = (cwd, ...args) =>
  run(
    'git',
    [
      '-c',
      'user.name=ContextOS release fixture',
      '-c',
      'user.email=release@example.invalid',
      '-C',
      cwd,
      ...args
    ],
    cwd
  ).trim();
const check = async (name, test) => {
  const start = performance.now();
  try {
    const detail = await test();
    results.push({
      name,
      status: 'passed',
      durationMs: Math.round(performance.now() - start),
      detail
    });
    console.log(`PASS ${name}`);
    return detail;
  } catch (error) {
    results.push({ name, status: 'failed', error: error.stack });
    throw error;
  }
};
const waitFor = async (test, label) => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await test()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${label}`);
};
const decode = (result) => {
  assert.ok(!result.isError, JSON.stringify(result.content));
  return (
    result.structuredContent ??
    JSON.parse(result.content.find((block) => block.type === 'text').text)
  );
};
try {
  const require = createRequire(path.join(checkout, 'package.json'));
  const SQLite = require('better-sqlite3');
  const { SCHEMA_SQL } = await import(
    pathToFileURL(path.join(checkout, 'dist/src/core/storage/schema.js'))
  );
  fs.mkdirSync(path.join(legacy, '.contextos'));
  const original = new SQLite(path.join(legacy, '.contextos/index.db'));
  original.exec(SCHEMA_SQL);
  original.prepare('INSERT INTO schema_version VALUES (6)').run();
  original
    .prepare(
      "INSERT INTO knowledge_facts (id,fact,created_at,updated_at,last_accessed) VALUES ('old-memory','Retain this existing user memory',1,1,1)"
    )
    .run();
  original.close();
  fs.writeFileSync(
    path.join(legacy, 'payment.ts'),
    'export type LegacyPaymentStatus = "pending" | "paid";\n'
  );
  fs.writeFileSync(path.join(legacy, 'CLAUDE.md'), 'Preserve user-written project guidance.\n');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(
    path.join(home, '.claude/CLAUDE.md'),
    'Preserve user-written global guidance.\n'
  );
  await check('global npm install runs migration and preserves user instructions', () => {
    run(
      'npm',
      ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', archive],
      legacy,
      300_000
    );
    cli = path.join(prefix, 'lib/node_modules/@siddharthakatiyar/contextos/dist/bin/contextos.js');
    assert.equal(command(['--version']).trim(), version);
    assert.ok(fs.existsSync(path.join(prefix, 'bin/contextos')));
    assert.equal(json(['setup', '--check', '--json']).status, 'registered');
    assert.match(
      fs.readFileSync(path.join(legacy, 'CLAUDE.md'), 'utf8'),
      /Preserve user-written project guidance/
    );
    assert.match(
      fs.readFileSync(path.join(home, '.claude/CLAUDE.md'), 'utf8'),
      /Preserve user-written global guidance/
    );
    for (const file of [
      '.codex/AGENTS.md',
      '.claude/AGENTS.md',
      '.grok/AGENTS.md',
      '.config/opencode/AGENTS.md',
      '.gemini/GEMINI.md',
      '.config/amp/AGENTS.md',
      '.copilot/copilot-instructions.md',
      '.codeium/windsurf/memories/global_rules.md'
    ])
      assert.ok(fs.existsSync(path.join(home, file)), file);
  });
  await check('cold and warm JSON queries rebuild legacy indexes and retain memories', () => {
    for (let i = 0; i < 2; i++)
      assert.match(json(['query', 'LegacyPaymentStatus', '--json']).context, /LegacyPaymentStatus/);
    const view = json(['status', '--json']).views[0];
    const db = new SQLite(view.dbPath, { readonly: true });
    assert.equal(
      db.prepare("SELECT fact FROM knowledge_facts WHERE id='old-memory'").get().fact,
      'Retain this existing user memory'
    );
    db.close();
    assert.ok(fs.existsSync(path.join(legacy, '.contextos/index.db')));
  });
  await check('fresh projects remain uninitialized', () => {
    const fresh = path.join(root, 'fresh');
    fs.mkdirSync(fresh);
    assert.equal(json(['setup', '--check', '--json'], fresh).status, 'not_initialized');
    assert.deepEqual(fs.readdirSync(fresh), []);
  });
  const packageRoot = path.dirname(path.dirname(path.dirname(cli)));
  const installedRequire = createRequire(path.join(packageRoot, 'package.json'));
  const installed = (module) => import(pathToFileURL(installedRequire.resolve(module)));
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    installed('@modelcontextprotocol/sdk/client/index.js'),
    installed('@modelcontextprotocol/sdk/client/stdio.js')
  ]);
  if (previousArchive) {
    await check(
      'live previous-release daemon is replaced automatically and knowledge survives',
      async () => {
        run(
          'npm',
          ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', previousArchive],
          legacy,
          300_000
        );
        const previousVersion = command(['--version']).trim();
        assert.notEqual(previousVersion, version);
        const client = new Client({ name: 'live-upgrade-check', version });
        clients.push(client);
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [cli, 'serve'],
          cwd: legacy,
          env,
          stderr: 'pipe'
        });
        transport.stderr?.on('data', () => {});
        await client.connect(transport);
        assert.equal(client.getServerVersion().version, previousVersion);
        const remembered = await client.callTool({
          name: 'ctx_remember',
          arguments: { content: 'LiveUpgradeMemorySurvives', provenance: 'user' }
        });
        assert.ok(!remembered.isError);
        const pidFile = path.join(home, '.contextos/runtime/daemon.pid');
        const oldPid = Number(fs.readFileSync(pidFile, 'utf8'));
        run(
          'npm',
          ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', archive],
          legacy,
          300_000
        );
        assert.equal(command(['--version']).trim(), version);
        let alive = true;
        try {
          process.kill(oldPid, 0);
        } catch (error) {
          if (error.code === 'ESRCH') alive = false;
          else throw error;
        }
        assert.equal(
          alive,
          false,
          'The previous-release daemon still owns the workspace after installation'
        );
        const retrieved = await client.callTool(
          { name: 'get_context', arguments: { prompt: 'LiveUpgradeMemorySurvives', tier: 'full' } },
          undefined,
          { timeout: 90_000 }
        );
        assert.ok(!retrieved.isError, JSON.stringify(retrieved.content));
        assert.ok(JSON.stringify(retrieved.content).includes('LiveUpgradeMemorySurvives'));
        assert.equal(
          JSON.parse(
            fs.readFileSync(path.join(home, '.contextos/installation-setup.json'))
          ).revision.split(':')[0],
          version
        );
        await client.close();
        clients.splice(clients.indexOf(client), 1);
        command(['daemon', 'stop', '--all']);
        return { previousVersion, version, previousDaemonExited: true, clientReconnected: true };
      }
    );
  }
  const projects = {};
  let feature;
  await check(
    'four independent projects and a Git worktree initialize through the installed CLI',
    () => {
      command(['group', 'create', 'payments']);
      for (const name of ['backend', 'frontend', 'shared-types', 'infrastructure']) {
        const directory = path.join(root, name);
        projects[name] = directory;
        fs.cpSync(path.join(checkout, 'tests/fixtures/workspace', name), directory, {
          recursive: true
        });
        if (name === 'backend') {
          const payment = path.join(directory, 'payment.ts');
          fs.writeFileSync(
            payment,
            fs
              .readFileSync(payment, 'utf8')
              .replace('../shared-types/payment.js', '../shared-types/payment.ts')
          );
          fs.writeFileSync(
            path.join(directory, 'api.yaml'),
            'openapi: 3.0.0\ninfo:\n  title: Payment API\n  version: 1.0.0\npaths:\n  /checkout:\n    post:\n      operationId: createCheckout\n      responses:\n        "200":\n          description: created\n'
          );
        }
        git(directory, 'init', '-b', 'main');
        git(directory, 'add', '.');
        git(directory, 'commit', '-m', 'Release fixture');
        if (name === 'backend') {
          feature = path.join(root, 'backend-feature');
          git(directory, 'worktree', 'add', '-b', 'feature/release', feature);
          fs.writeFileSync(
            path.join(feature, 'feature.ts'),
            'export function branchOnlyMarker() { return "feature"; }\n'
          );
        }
        const initialized = json(['init', directory, '--group', 'payments', '--json']);
        assert.equal(initialized.status, 'registered');
        assert.ok(!fs.existsSync(path.join(directory, '.contextos')));
      }
      const views = json(['status', '--group', 'payments', '--json']).views;
      assert.equal(views.length, 5);
      assert.equal(new Set(views.map((view) => view.viewId)).size, 5);
      assert.equal(new Set(views.map((view) => view.dbPath)).size, 5);
    }
  );
  await check('combined ranking, provenance, scopes, and worktree isolation', () => {
    const combined = json(
      [
        'query',
        'Where is payment status defined, processed, and displayed?',
        '--group',
        'payments',
        '--json',
        '--max-tokens',
        '4000'
      ],
      projects.backend
    );
    for (const name of ['backend', 'frontend', 'shared-types'])
      assert.match(combined.context, new RegExp(name + '/payment.ts'));
    assert.equal(new Set(combined.chunks.map((chunk) => chunk.id)).size, combined.chunks.length);
    assert.equal(
      json(['query', 'branchOnlyMarker', '--worktree', feature, '--json'], projects.backend).scope
        .repoIds.length,
      1
    );
    assert.equal(
      json(
        ['query', 'payment', '--group', 'payments', '--all-worktrees', '--json'],
        projects.backend
      ).scope.repoIds.length,
      5
    );
    assert.throws(() =>
      command(['query', 'payment', '--repo', 'backend', '--all-repos'], projects.backend)
    );
    assert.throws(() => command(['query', 'payment', '--repo', 'unknown'], projects.backend));
  });
  const connect = async (project) => {
    const client = new Client({ name: 'release-package-check', version });
    clients.push(client);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, 'serve', '--group', 'payments', '--project', project],
      cwd: projects[project],
      env,
      stderr: 'pipe'
    });
    transport.stderr?.on('data', () => {});
    await client.connect(transport);
    return client;
  };
  const backend = await connect('backend'),
    frontend = await connect('frontend');
  const call = async (client, name, args = {}) =>
    decode(await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }));
  await check('installed MCP tool inventory, independent clients, and token budgets', async () => {
    const tools = (await backend.listTools()).tools.map((tool) => tool.name);
    for (const tool of [
      'get_context',
      'ctx_scope',
      'ctx_link',
      'ctx_links',
      'ctx_unlink',
      'ctx_remember',
      'ctx_forget',
      'ctx_trace',
      'ctx_resolve_import',
      'ctx_contract',
      'ctx_read_file',
      'ctx_expand',
      'ctx_symbol',
      'ctx_execute',
      'contextos_status',
      'reindex_context'
    ])
      assert.ok(tools.includes(tool), tool);
    assert.equal((await call(backend, 'ctx_scope')).sources[0].name, 'backend');
    assert.equal((await call(frontend, 'ctx_scope')).sources[0].name, 'frontend');
    for (const output_format of ['markdown', 'xml']) {
      const result = await call(backend, 'get_context', {
        prompt: 'payment status',
        group: 'payments',
        max_tokens: 1200,
        output_format
      });
      assert.ok(result.tokens <= 1200);
      assert.equal(result.scope.repoIds.length, 4);
    }
    await call(backend, 'ctx_remember', {
      type: 'session_note',
      content: 'ReleaseSessionOnlyMarker'
    });
    const other = await frontend.callTool({
      name: 'get_context',
      arguments: { prompt: 'ReleaseSessionOnlyMarker', tier: 'full' }
    });
    assert.ok(!JSON.stringify(other.content).includes('ReleaseSessionOnlyMarker'));
  });
  await check(
    'exact import and OpenAPI inspection, verified links, tracing, and knowledge lifecycle',
    async () => {
      const source = (await call(backend, 'ctx_symbol', { symbolName: 'processPaymentStatus' }))
        .chunks[0].ref;
      const target = (
        await call(backend, 'ctx_symbol', {
          symbolName: 'PaymentStatus',
          project: 'shared-types',
          group: 'payments'
        })
      ).chunks[0].ref;
      const resolved = await call(backend, 'ctx_resolve_import', {
        group: 'payments',
        source,
        specifier: '../shared-types/payment.ts',
        symbol: 'PaymentStatus',
        mode: 'types'
      });
      assert.equal(resolved.resolved, true, JSON.stringify(resolved));
      const scope = await call(backend, 'ctx_scope', { group: 'payments' });
      const expected_generations = Object.fromEntries(
        scope.sources.map((view) => [view.viewId, view.generation])
      );
      const link = await call(backend, 'ctx_link', {
        group: 'payments',
        source,
        target,
        relationship: 'imports',
        rationale:
          'The fixture source imports PaymentStatus from the shared payment file and uses it in the processPaymentStatus signature.',
        evidence: [source, target],
        expected_generations
      });
      assert.ok(link.link.id);
      const traced = await call(backend, 'ctx_trace', { group: 'payments', start: source, target });
      assert.equal(traced.found, true, JSON.stringify(traced));
      const contracts = await call(backend, 'get_context', {
        prompt: 'createCheckout POST checkout OpenAPI',
        tier: 'full'
      });
      const contractRef = contracts.chunks.find((chunk) => chunk.relativePath === 'api.yaml')?.ref;
      assert.ok(contractRef);
      const contract = await call(backend, 'ctx_contract', {
        ref: contractRef,
        operation: 'POST /checkout'
      });
      assert.ok(JSON.stringify(contract).includes('createCheckout'));
      const fact = await call(backend, 'ctx_remember', {
        content: 'ReleaseFixturePreference: retain grouped payments context.',
        provenance: 'user'
      });
      command(['reindex', '--repo', 'backend'], projects.backend);
      assert.ok(
        JSON.stringify(
          (
            await backend.callTool({
              name: 'get_context',
              arguments: { prompt: 'ReleaseFixturePreference', tier: 'full' }
            })
          ).content
        ).includes('ReleaseFixturePreference')
      );
      await call(backend, 'ctx_forget', { id: fact.fact.id });
      await call(backend, 'ctx_unlink', { group: 'payments', id: link.link.id });
      assert.ok(
        (
          await backend.callTool({
            name: 'ctx_remember',
            arguments: { content: 'Unverified source claim', provenance: 'code' }
          })
        ).isError
      );
    }
  );
  await check('watcher updates, atomic replacements, deletion, and path containment', async () => {
    const marker = path.join(projects.backend, 'watch.ts');
    fs.writeFileSync(marker, 'export function watcherAddedMarker() {}\n');
    await waitFor(
      async () =>
        (await call(backend, 'ctx_symbol', { symbolName: 'watcherAddedMarker' })).chunks.length > 0,
      'watcher add'
    );
    fs.writeFileSync(marker + '.tmp', 'export function watcherAtomicMarker() {}\n');
    fs.renameSync(marker + '.tmp', marker);
    await waitFor(
      async () =>
        (await call(backend, 'ctx_symbol', { symbolName: 'watcherAtomicMarker' })).chunks.length >
        0,
      'atomic replacement'
    );
    fs.unlinkSync(marker);
    await waitFor(
      async () =>
        !(await call(backend, 'ctx_symbol', { symbolName: 'watcherAtomicMarker' })).chunks.length,
      'watcher deletion'
    );
    assert.ok(
      (await backend.callTool({ name: 'ctx_read_file', arguments: { filePath: '../secret.txt' } }))
        .isError
    );
    assert.ok(
      (await backend.callTool({ name: 'ctx_execute', arguments: { command: 'sh -c true' } }))
        .isError
    );
    command(['group', 'remove', 'payments', 'frontend']);
    assert.equal(
      (await call(backend, 'get_context', { prompt: 'payment', group: 'payments' })).scope.repoIds
        .length,
      3
    );
    command(['group', 'add', 'payments', projects.frontend]);
    assert.equal(
      (await call(backend, 'get_context', { prompt: 'payment', group: 'payments' })).scope.repoIds
        .length,
      4
    );
  });
  for (const client of clients) await client.close();
  clients.length = 0;
  command(['daemon', 'stop', '--all']);
  await check('removed worktree cleanup retains source projects and other indexes', () => {
    const before = json(['status', '--group', 'payments', '--json']).views;
    const removed = before.find((view) => view.rootPath === feature);
    git(projects.backend, 'worktree', 'remove', '--force', feature);
    const plan = json(['clean', '--dry-run'], projects.backend);
    assert.ok(plan.actions.some((action) => action.viewIds.includes(removed.viewId)));
    assert.ok(fs.existsSync(removed.dbPath));
    json(['clean'], projects.backend);
    assert.ok(!fs.existsSync(removed.dbPath));
    assert.ok(fs.existsSync(path.join(projects.backend, 'payment.ts')));
    for (const view of before.filter((view) => view.viewId !== removed.viewId))
      assert.ok(fs.existsSync(view.dbPath));
  });
} catch (error) {
  process.exitCode = 1;
  console.error(error.stack);
} finally {
  for (const client of clients) await client.close().catch(() => {});
  if (cli) {
    try {
      command(['daemon', 'stop', '--all']);
    } catch {
      /* Preserve the original failure. */
    }
  }
  const report = {
    version,
    archive,
    archiveSha256: createHash('sha256').update(fs.readFileSync(archive)).digest('hex'),
    startedAt,
    completedAt: new Date().toISOString(),
    results,
    passed: results.every((test) => test.status === 'passed') && !process.exitCode
  };
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`Report: ${output}`);
}
