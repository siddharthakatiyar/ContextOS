#!/usr/bin/env node
// Real 1.0.x data and daemon, isolated from the user's projects and installation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const candidate = path.resolve(process.argv[2]);
const baseline = path.resolve(process.argv[3]);
const output = path.resolve(process.argv[4]);
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-legacy-upgrade-')));
const home = path.join(root, 'home'),
  project = path.join(root, 'project'),
  prefix = path.join(root, 'global');
fs.mkdirSync(home);
fs.mkdirSync(project);
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CONTEXTOS_EMBEDDINGS: '0',
  CONTEXTOS_AUTO_PATCH_REEXEC: '1',
  ONNXRUNTIME_NODE_INSTALL: 'skip'
};
for (const key of [
  'CONTEXTOS_SKIP_SETUP',
  'CONTEXTOS_GLOBAL_INSTRUCTIONS',
  'CONTEXTOS_REPO_ROOT',
  'CONTEXTOS_UPGRADE_TOKEN',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'COPILOT_HOME'
])
  delete env[key];
// Imports from the historical package must use the same isolated home as its CLI.
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'COPILOT_HOME'])
  delete process.env[key];
const packageRoot = path.join(prefix, 'lib/node_modules/@siddharthakatiyar/contextos');
const cli = path.join(packageRoot, 'dist/bin/contextos.js');
const run = (command, args, timeout = 90_000) =>
  execFileSync(command, args, {
    env,
    cwd: project,
    timeout,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
const command = (args) => run(process.execPath, [cli, ...args]);
const install = (archive) =>
  run(
    'npm',
    ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', archive],
    300_000
  );
const wait = async (predicate, label) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timeout: ${label}`);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
};
const checks = [];
let db, legacyPid, report;
try {
  fs.writeFileSync(
    path.join(project, 'payment.ts'),
    'export function LegacyCheckoutStatus() { return "paid"; }\n'
  );
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), 'Keep my project guidance.\n');
  install(baseline);
  assert.match(command(['--version']).trim(), /^1\.0\./);
  command(['init']);
  const state = path.join(project, '.contextos');
  await wait(() => fs.existsSync(path.join(state, 'daemon.pid')), 'legacy daemon');
  legacyPid = Number(fs.readFileSync(path.join(state, 'daemon.pid'), 'utf8'));
  await wait(() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(state, 'status.json'))).fullIndexCompleted;
    } catch {
      return false;
    }
  }, 'legacy indexing');
  const [{ DB }, { KnowledgeStore }] = await Promise.all([
    import(pathToFileURL(path.join(packageRoot, 'dist/src/core/storage/database.js'))),
    import(pathToFileURL(path.join(packageRoot, 'dist/src/core/memory/knowledge-store.js')))
  ]);
  db = new DB(path.join(state, 'index.db'));
  const sql = db.getInstance();
  assert.equal(sql.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 6);
  const factId = new KnowledgeStore(db).learnFact('DirectLegacyUpgradeMemory', 'upgrade-fixture');
  sql
    .prepare('INSERT INTO sessions (id, started_at, repo_root) VALUES (?, ?, ?)')
    .run('saved-session', 1, project);
  sql
    .prepare(
      'INSERT INTO session_events (session_id,event_type,content,created_at) VALUES (?,?,?,?)'
    )
    .run('saved-session', 'user_prompt', 'KeepLegacySessionHistory', 1);
  sql
    .prepare('INSERT INTO prompts (id,prompt,created_at) VALUES (?,?,?)')
    .run('saved-prompt', 'KeepLegacyPromptHistory', 1);
  const chunkIds = sql
    .prepare('SELECT id FROM chunks ORDER BY id')
    .all()
    .map((row) => row.id);
  assert.ok(chunkIds.length);
  const backup = path.join(root, 'before-upgrade.db');
  await sql.backup(backup);
  db.close();
  db = undefined;
  checks.push(
    'published 1.0.x creates an indexed project with saved memory, sessions, prompts and a SQLite backup'
  );
  // This daemon predates the authenticated upgrade protocol. Refusal is required:
  // no package/PID guess may turn an unverifiable control response into a signal.
  install(candidate);
  assert.ok(alive(legacyPid), 'An unsupported daemon must not be signalled automatically');
  assert.ok(!fs.existsSync(path.join(home, '.contextos/registry.db')));
  db = new DB(path.join(state, 'index.db'));
  assert.equal(
    db.getInstance().prepare('SELECT fact FROM knowledge_facts WHERE id=?').get(factId).fact,
    'DirectLegacyUpgradeMemory'
  );
  db.close();
  db = undefined;
  checks.push(
    'direct installation retains saved data and refuses automatic shutdown without authenticated legacy control'
  );
  process.kill(legacyPid, 'SIGTERM');
  await wait(() => !fs.existsSync(path.join(state, 'daemon.pid')), 'legacy stop acknowledgment');
  // 1.0.x leaves its 30-minute GC timer alive after closing its database and
  // watcher. Terminate only this test-created process to exercise recovery;
  // the product's installation hook never uses SIGKILL.
  if (alive(legacyPid)) process.kill(legacyPid, 'SIGKILL');
  await wait(() => !alive(legacyPid), 'fixture process exit');
  const configuration = path.join(project, '.mcp.json');
  const previousConfiguration = fs.readFileSync(configuration, 'utf8');
  fs.writeFileSync(configuration, '{invalid-json');
  const failed = spawnSync(process.execPath, [cli, 'setup', '--upgrade', '--no-index', '--json'], {
    cwd: project,
    env,
    encoding: 'utf8',
    timeout: 90_000
  });
  assert.equal(failed.status, 1, failed.stderr);
  assert.ok(JSON.parse(failed.stdout).errors.length);
  fs.writeFileSync(configuration, previousConfiguration);
  const recovered = JSON.parse(command(['setup', '--upgrade', '--no-index', '--json']));
  assert.equal(recovered.errors.length, 0);
  const view = JSON.parse(command(['status', '--json'])).views[0];
  db = new DB(view.dbPath);
  const migrated = db.getInstance();
  assert.equal(
    migrated.prepare('SELECT fact FROM knowledge_facts WHERE id=?').get(factId).fact,
    'DirectLegacyUpgradeMemory'
  );
  assert.equal(
    migrated.prepare('SELECT content FROM session_events WHERE session_id=?').get('saved-session')
      .content,
    'KeepLegacySessionHistory'
  );
  assert.equal(
    migrated.prepare('SELECT prompt FROM prompts WHERE id=?').get('saved-prompt').prompt,
    'KeepLegacyPromptHistory'
  );
  assert.deepEqual(
    migrated
      .prepare('SELECT id FROM chunks ORDER BY id')
      .all()
      .map((row) => row.id),
    chunkIds
  );
  db.close();
  db = undefined;
  assert.ok(fs.existsSync(backup));
  assert.ok(fs.existsSync(path.join(state, 'index.db')));
  assert.match(
    fs.readFileSync(path.join(project, 'CLAUDE.md'), 'utf8'),
    /Keep my project guidance/
  );
  checks.push(
    'interrupted setup retries after configuration repair and preserves IDs, memory and history in the global view and legacy source'
  );
  const rebuilt = JSON.parse(
    command(['query', 'LegacyCheckoutStatus DirectLegacyUpgradeMemory', '--json'])
  );
  assert.match(rebuilt.context, /LegacyCheckoutStatus/);
  db = new DB(view.dbPath);
  assert.equal(
    db.getInstance().prepare('SELECT fact FROM knowledge_facts WHERE id=?').get(factId).fact,
    'DirectLegacyUpgradeMemory'
  );
  db.close();
  db = undefined;
  checks.push('first-use reindex answers from migrated source while retaining saved memory');
  report = { baseline: '1.0.3', candidate: command(['--version']).trim(), checks, passed: true };
} catch (error) {
  report = { baseline: '1.0.3', checks, passed: false, error: error.stack };
  process.exitCode = 1;
} finally {
  db?.close();
  if (legacyPid && alive(legacyPid)) {
    process.kill(legacyPid, 'SIGKILL');
    await wait(() => !alive(legacyPid), 'fixture shutdown');
  }
  if (fs.existsSync(cli)) {
    try {
      command(['daemon', 'stop', '--all']);
    } catch {
      /* Keep the original failure. */
    }
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  fs.rmSync(root, { recursive: true, force: true });
}
