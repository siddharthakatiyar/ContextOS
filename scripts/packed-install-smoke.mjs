#!/usr/bin/env node
// Run through npm so npm_execpath identifies its CLI on every supported platform.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const archive = path.resolve(process.argv[2]);
const output = process.argv[3] && path.resolve(process.argv[3]);
const version = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version;
const npmCli = process.env.npm_execpath;
assert.ok(
  npmCli && fs.existsSync(npmCli),
  'Run with npm run test:packed-install -- <tarball> [report]'
);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-packed-')));
const home = path.join(root, 'home');
const prefix = path.join(root, 'global');
const project = path.join(root, 'project');
fs.mkdirSync(home);
fs.mkdirSync(project);
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData/Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData/Local'),
  CODEX_HOME: path.join(home, '.codex'),
  CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
  XDG_CONFIG_HOME: path.join(home, '.config'),
  COPILOT_HOME: path.join(home, '.copilot'),
  CONTEXTOS_EMBEDDINGS: '0',
  CONTEXTOS_AUTO_PATCH_REEXEC: '1',
  ONNXRUNTIME_NODE_INSTALL: 'skip'
};
for (const key of [
  'CONTEXTOS_SKIP_SETUP',
  'CONTEXTOS_GLOBAL_INSTRUCTIONS',
  'CONTEXTOS_REPO_ROOT',
  'CONTEXTOS_UPGRADE_TOKEN',
  'CONTEXTOS_MCP_COMMAND',
  'CONTEXTOS_MCP_ARGS'
])
  delete env[key];
const files = [
  '.codex/AGENTS.md',
  '.claude/AGENTS.md',
  '.claude/CLAUDE.md',
  '.grok/AGENTS.md',
  '.config/opencode/AGENTS.md',
  '.gemini/GEMINI.md',
  '.config/amp/AGENTS.md',
  '.copilot/copilot-instructions.md',
  '.codeium/windsurf/memories/global_rules.md'
];
const run = (args, cwd = project, timeout = 90_000) =>
  execFileSync(process.execPath, args, {
    cwd,
    env,
    timeout,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
const install = (destination) =>
  run(
    [npmCli, 'install', '--global', '--prefix', destination, '--no-audit', '--no-fund', archive],
    project,
    300_000
  );
const snapshot = () =>
  files.map((file) => {
    const absolute = path.join(home, file);
    const stat = fs.statSync(absolute);
    return {
      file,
      content: fs.readFileSync(absolute, 'utf8'),
      modified: stat.mtimeMs,
      mode: stat.mode
    };
  });
const checks = [];
let report;
try {
  const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  if (process.env.EXPECTED_RELEASE_SHA256)
    assert.equal(sha256, process.env.EXPECTED_RELEASE_SHA256);
  for (const file of files) {
    const absolute = path.join(home, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(
      absolute,
      `User guidance for ${file}\r\n<!-- contextos:managed:start -->\nPreviously installed ContextOS block\n<!-- contextos:managed:end -->\n`
    );
  }
  const before = snapshot();
  install(prefix);
  assert.deepEqual(snapshot(), before);
  assert.ok(!fs.existsSync(path.join(home, '.contextos')));
  checks.push(
    'default global install preserves all existing agent files and creates no project registry'
  );
  const packageRoot = path.join(
    prefix,
    ...(process.platform === 'win32' ? [] : ['lib']),
    'node_modules/@siddharthakatiyar/contextos'
  );
  const cli = path.join(packageRoot, 'dist/bin/contextos.js');
  const command = (args) => run([cli, ...args]);
  const json = (args) => JSON.parse(command(args));
  assert.equal(command(['--version']).trim(), version);
  assert.ok(
    fs.existsSync(
      path.join(prefix, process.platform === 'win32' ? 'contextos.cmd' : 'bin/contextos')
    )
  );
  fs.writeFileSync(
    path.join(project, 'payment.ts'),
    'export type PackedPaymentStatus = "pending" | "paid";\n'
  );
  assert.equal(json(['init', '--no-index', '--json']).status, 'registered');
  assert.match(json(['query', 'PackedPaymentStatus', '--json']).context, /PackedPaymentStatus/);
  assert.ok(!fs.existsSync(path.join(project, '.contextos')));
  assert.deepEqual(snapshot(), before);
  checks.push(
    'installed CLI initializes and answers a cold JSON query without changing global instructions'
  );
  assert.ok(
    json(['enable', '--dry-run', '--json']).results.some(
      (result) => result.status === 'would-update'
    )
  );
  assert.deepEqual(snapshot(), before);
  const enabled = json(['enable', '--json']);
  assert.ok(enabled.results.every((result) => result.status !== 'error'));
  for (const file of files) {
    const content = fs.readFileSync(path.join(home, file), 'utf8');
    assert.ok(content.includes(`User guidance for ${file}`));
    if (file === '.claude/CLAUDE.md') assert.match(content, /@AGENTS\.md/);
    else assert.equal(content.match(/contextos:managed:start/g)?.length, 1);
  }
  const afterEnable = snapshot();
  command(['enable', '--json']);
  assert.deepEqual(snapshot(), afterEnable);
  checks.push('explicit enable preserves user text, migrates managed blocks and is idempotent');
  const local = path.join(root, 'local');
  fs.mkdirSync(local);
  run([npmCli, 'install', '--prefix', local, '--no-audit', '--no-fund', archive], local, 300_000);
  assert.deepEqual(snapshot(), afterEnable);
  checks.push('local npm installation leaves global agent files untouched');
  assert.equal(createHash('sha256').update(fs.readFileSync(archive)).digest('hex'), sha256);
  report = {
    version,
    platform: process.platform,
    node: process.version,
    sha256,
    checks,
    passed: true
  };
} catch (error) {
  report = {
    version,
    platform: process.platform,
    node: process.version,
    checks,
    passed: false,
    error: error.stack
  };
  process.exitCode = 1;
} finally {
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
}
