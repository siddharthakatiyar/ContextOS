#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ROOT = path.join(REPO_ROOT, '.tmp', 'fresh-agent-release');
const REPORT_PATH = path.join(REPO_ROOT, 'validation', 'fresh-agent-sessions.json');
const CONTEXTOS_ENTRY = path.join(REPO_ROOT, 'dist', 'bin', 'contextos.js');
const CLIENTS = ['codex', 'claude', 'grok'];

export const ARCHITECTURE_QUESTION =
  'Starting with the POST /captures route, trace how a request is dispatched and persisted. Which operation key selects the handler, which concrete storage function is called, and which SQL table is written? Verify the imports and call sites, and tell me whether the similarly named legacy saveCapture implementation is on this path. If you can establish a cross-repository dependency, save the best-supported relationship with evidence. Work read-only except for the knowledge store.';

const REUSE_QUESTION =
  'In this new session, verify the previously recorded dependency between the request handler and its storage package by consulting the saved project relationships. Report the relation and its evidence. Do not create another relationship.';

const INVALIDATION_QUESTION =
  'Check whether the previously recorded handler-to-storage relationship is still supported by current indexed evidence. Inspect its saved evidence and report whether it is current or stale. Do not create or repair relationships.';

const REPOS = [
  {
    name: 'api-contract',
    files: {
      'package.json': JSON.stringify(
        {
          name: '@ledger/api-contract',
          version: '1.0.0',
          type: 'module',
          exports: { './routes': './src/routes.ts' }
        },
        null,
        2
      ),
      'src/routes.ts': `export const operations = {
  capture_to_ledger: { method: 'POST', path: '/captures' }
} as const;
`
    }
  },
  {
    name: 'service-map',
    files: {
      'package.json': JSON.stringify(
        {
          name: '@ledger/service-map',
          version: '1.0.0',
          type: 'module',
          dependencies: { '@ledger/api-contract': 'file:../api-contract' },
          exports: { '.': './src/index.ts' }
        },
        null,
        2
      ),
      'src/index.ts': `import { operations } from '@ledger/api-contract/routes';

export const routeMappings = {
  capture_to_ledger: { ...operations.capture_to_ledger, handler: 'payments.capture' }
} as const;
`
    }
  },
  {
    name: 'payment-api',
    files: {
      'package.json': JSON.stringify(
        {
          name: '@ledger/payment-api',
          version: '1.0.0',
          type: 'module',
          dependencies: {
            '@ledger/service-map': 'file:../service-map',
            '@ledger/pg-store': 'file:../pg-store'
          }
        },
        null,
        2
      ),
      'src/routes.ts': `import { routeMappings } from '@ledger/service-map';
import { paymentHandlers } from './handlers.js';

export function registerRoutes(router: Router, db: Database) {
  for (const route of Object.values(routeMappings)) {
    router.register(route.method, route.path, (request) => paymentHandlers[route.handler](request.body, db));
  }
}

type Request = { body: Capture };
type Capture = { id: string; amount: number };
type Database = { query(sql: string, values: unknown[]): Promise<unknown> };
type Handler = (capture: Capture, db: Database) => Promise<unknown>;
type Router = { register(method: string, path: string, handler: (request: Request) => unknown): void };
`,
      'src/handlers.ts': `import { saveCapture } from '@ledger/pg-store/captures';

export async function capturePayment(capture: Capture, db: Database) {
  return saveCapture(db, capture);
}

export const paymentHandlers = {
  'payments.capture': capturePayment
};

type Capture = { id: string; amount: number };
type Database = { query(sql: string, values: unknown[]): Promise<unknown> };
`
    }
  },
  {
    name: 'pg-store',
    files: {
      'package.json': JSON.stringify(
        {
          name: '@ledger/pg-store',
          version: '1.0.0',
          type: 'module',
          exports: { './captures': './src/captures.ts' }
        },
        null,
        2
      ),
      'src/captures.ts': `export async function saveCapture(db: Database, capture: Capture) {
  return db.query('INSERT INTO captures (id, amount) VALUES ($1, $2)', [capture.id, capture.amount]);
}

type Capture = { id: string; amount: number };
type Database = { query(sql: string, values: unknown[]): Promise<unknown> };
`,
      'src/legacy-archive.ts': `// Historical file-backed implementation. It is not exported or imported by the API.
export async function saveCapture(capture: { id: string; amount: number }) {
  return appendFile('captures.jsonl', JSON.stringify(capture));
}

declare function appendFile(path: string, content: string): Promise<void>;
`
    }
  }
];

const EVENT_PATH = path.join(RUN_ROOT, 'events.jsonl');

export function parseJsonLines(input) {
  const records = [];
  const malformed = [];
  for (const [index, line] of String(input).split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed.push({ line: index + 1, text: line.slice(0, 300) });
    }
  }
  return { records, malformed };
}

function collectAgentActions(value, actions = [], seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return actions;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) collectAgentActions(child, actions, seen);
    return actions;
  }

  const type = String(value.type ?? value.sessionUpdate ?? value.kind ?? '').toLowerCase();
  const item = value.item && typeof value.item === 'object' ? value.item : undefined;
  const tool = value.toolCall && typeof value.toolCall === 'object' ? value.toolCall : undefined;
  const name = value.name ?? value.tool_name ?? value.toolName ?? value.tool ?? tool?.name;
  const command = value.command ?? item?.command ?? value.input?.command ?? value.rawInput?.command;
  if (
    typeof command === 'string' &&
    /command|shell|bash|exec/.test(type + String(item?.type ?? '') + String(name ?? ''))
  ) {
    actions.push({ kind: 'command', command });
  } else if (
    typeof name === 'string' &&
    (/tool|call/.test(type + String(item?.type ?? '')) ||
      name.startsWith('mcp__') ||
      name.includes('__'))
  ) {
    actions.push({ kind: 'tool', name });
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === 'parent') continue;
    collectAgentActions(child, actions, seen);
  }
  return actions;
}

export function parseAgentTranscript(input) {
  const parsed = parseJsonLines(input);
  const events = [];
  for (const record of parsed.records) {
    for (const action of collectAgentActions(record)) events.push(action);
  }
  return { events, malformed: parsed.malformed };
}

export function isBroadSearch(command) {
  return /(?:^|[\s|;&])(?:rg|ripgrep|grep|find|fd|ag|git\s+grep)(?:\s|$)/i.test(command);
}

function resultData(event) {
  if (event.structured) return event.structured;
  try {
    return JSON.parse(event.text ?? '');
  } catch {
    return null;
  }
}
function collectLinks(value, links = []) {
  if (!value || typeof value !== 'object') return links;
  if (Array.isArray(value)) {
    for (const item of value) collectLinks(item, links);
    return links;
  }
  if (
    typeof value.id === 'string' &&
    typeof value.source === 'string' &&
    typeof value.target === 'string'
  )
    links.push(value);
  for (const item of Object.values(value)) collectLinks(item, links);
  return links;
}
export function evaluateProtocol({ mcpEvents = [], agentEvents = [] }) {
  const calls = mcpEvents.filter((event) => event.kind === 'mcp_call');
  const responseFor = (call) =>
    mcpEvents.find(
      (event) =>
        event.kind === 'mcp_result' &&
        event.client === call.client &&
        event.phase === call.phase &&
        event.id === call.id
    );
  const refPaths = new Map();
  const inspect = (value) => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const child of value) inspect(child);
      return;
    }
    const ref =
      value.ref ??
      value.chunkRef ??
      value.qualifiedRef ??
      value.reference ??
      (String(value.id).startsWith('contextos:') ? value.id : undefined);
    const file =
      value.relativePath ?? value.sourceFile ?? value.filePath ?? value.file ?? value.path;
    if (typeof ref === 'string' && typeof file === 'string')
      refPaths.set(ref, file.replaceAll('\\', '/'));
    for (const child of Object.values(value)) inspect(child);
  };
  for (const event of mcpEvents) if (event.kind === 'mcp_result') inspect(resultData(event));
  const contextCall = calls.find(
    (event) =>
      event.phase === 'initial' &&
      event.tool === 'get_context' &&
      responseFor(event) &&
      !responseFor(event).isError
  );
  const broadSearch = agentEvents.find(
    (event) =>
      event.phase === 'initial' && event.actionKind === 'command' && isBroadSearch(event.command)
  );
  const initialLinks = calls.filter(
    (event) => event.phase === 'initial' && event.tool === 'ctx_link'
  );
  const correct = (call) =>
    call.args?.relationship === 'imports' &&
    /(?:^|\/)src\/handlers\.ts$/.test(refPaths.get(call.args.source) ?? '') &&
    /(?:^|\/)src\/captures\.ts$/.test(refPaths.get(call.args.target) ?? '');
  const savedCall = initialLinks.find(
    (call) =>
      correct(call) &&
      responseFor(call) &&
      !responseFor(call).isError &&
      collectLinks(resultData(responseFor(call))).some(
        (link) => link.source === call.args.source && link.target === call.args.target
      )
  );
  const saved = savedCall
    ? collectLinks(resultData(responseFor(savedCall))).find(
        (link) => link.source === savedCall.args.source && link.target === savedCall.args.target
      )
    : null;
  const reads = (phase) =>
    calls.filter(
      (call) =>
        call.phase === phase &&
        ['ctx_links', 'ctx_trace'].includes(call.tool) &&
        responseFor(call) &&
        !responseFor(call).isError
    );
  const sameScope = (call) =>
    call.args?.all_repos === true ||
    (savedCall?.args?.group && call.args?.group === savedCall.args.group);
  const reuseRead = Boolean(
    saved &&
    reads('reuse').some((call) =>
      collectLinks(resultData(responseFor(call))).some(
        (link) =>
          link.id === saved.id && link.source === saved.source && link.target === saved.target
      )
    )
  );
  const invalidationRead = Boolean(
    saved &&
    reads('invalidation').some((call) => {
      if (!sameScope(call)) return false;
      const data = resultData(responseFor(call));
      if (!Array.isArray(data) && !Array.isArray(data?.links)) return false;
      return !collectLinks(data).some(
        (link) =>
          link.id === saved.id || (link.source === saved.source && link.target === saved.target)
      );
    })
  );
  const misleading = calls.some(
    (call) =>
      call.tool === 'ctx_link' &&
      /legacy-archive/.test(
        `${refPaths.get(call.args?.source) ?? ''} ${refPaths.get(call.args?.target) ?? ''}`
      ) &&
      responseFor(call) &&
      !responseFor(call).isError
  );
  return {
    retrievalBeforeBroadSearch: Boolean(
      contextCall && (!broadSearch || responseFor(contextCall).at <= broadSearch.at)
    ),
    broadSearchObserved: Boolean(broadSearch),
    correctLinkRequested: initialLinks.some(correct),
    correctLinkSaved: Boolean(saved),
    misleadingLegacyLinkSaved: misleading,
    reusedInNewSession: reuseRead,
    evidenceInvalidationChecked: invalidationRead,
    endpointPaths: {
      source: saved ? refPaths.get(saved.source) : null,
      target: saved ? refPaths.get(saved.target) : null
    },
    savedLinkId: saved?.id ?? null
  };
}

function appendEvent(event) {
  fs.mkdirSync(path.dirname(EVENT_PATH), { recursive: true });
  fs.appendFileSync(EVENT_PATH, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
}

function makeFixtureWorkspace() {
  stopFixtureDaemons();
  fs.rmSync(RUN_ROOT, { recursive: true, force: true });
  fs.mkdirSync(RUN_ROOT, { recursive: true });
  const workspace = path.join(RUN_ROOT, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  for (const repo of REPOS) {
    const repoPath = path.join(workspace, repo.name);
    fs.mkdirSync(repoPath, { recursive: true });
    for (const [relative, contents] of Object.entries(repo.files)) {
      const target = path.join(repoPath, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents);
    }
    const git = spawnSync('git', ['init', '--quiet', repoPath], { encoding: 'utf8' });
    if (git.status !== 0)
      throw new Error(`Could not initialize fixture repo ${repo.name}: ${git.stderr}`);
    spawnSync('git', ['-C', repoPath, 'config', 'user.name', 'Release Test'], { encoding: 'utf8' });
    spawnSync('git', ['-C', repoPath, 'config', 'user.email', 'release-test@example.invalid'], {
      encoding: 'utf8'
    });
    spawnSync('git', ['-C', repoPath, 'add', '.'], { encoding: 'utf8' });
    spawnSync('git', ['-C', repoPath, 'commit', '-m', 'fixture'], { encoding: 'utf8' });
  }
  return workspace;
}

function privateServerHome(client) {
  return path.join(RUN_ROOT, 'server-homes', client);
}

function stopFixtureDaemons() {
  return CLIENTS.map((client) => {
    const home = privateServerHome(client);
    if (!fs.existsSync(path.join(home, '.contextos', 'runtime')))
      return { client, status: 'not-started' };
    const result = spawnSync(process.execPath, [CONTEXTOS_ENTRY, 'daemon', 'stop'], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        CONTEXTOS_REPO_ROOT: path.join(RUN_ROOT, 'workspace', 'payment-api'),
        CONTEXTOS_AUTO_PATCH_REEXEC: '1'
      },
      encoding: 'utf8',
      timeout: 20000
    });
    return {
      client,
      status: result.status === 0 ? 'stopped' : 'cleanup-failed',
      code: result.status
    };
  });
}

function prepare() {
  if (!fs.existsSync(CONTEXTOS_ENTRY)) {
    throw new Error(
      `Missing local ContextOS build at ${CONTEXTOS_ENTRY}. Build the current checkout first.`
    );
  }
  const workspace = makeFixtureWorkspace();
  setProjectInstructionFiles(workspace);
  fs.writeFileSync(path.join(RUN_ROOT, 'workspace.path'), `${workspace}\n`);
  for (const client of CLIENTS) fs.mkdirSync(privateServerHome(client), { recursive: true });
  appendEvent({ kind: 'prepared', workspace });
  return { workspace, runRoot: RUN_ROOT, report: REPORT_PATH };
}

function proxyToolArgs(tool, input) {
  const args = input ?? {};
  if (tool === 'ctx_link') {
    return {
      relationship: args.relationship,
      source: args.source,
      target: args.target,
      rationale: args.rationale,
      evidence: args.evidence,
      expected_generations: args.expected_generations
    };
  }
  if (tool === 'get_context')
    return { group: args.group, project: args.project, repo: args.repo, prompt: args.prompt };
  if (tool === 'ctx_read_file')
    return { filePath: args.filePath, start_line: args.start_line, end_line: args.end_line };
  if (tool === 'ctx_expand') return { paths: args.paths, terms: args.terms };
  if (tool === 'ctx_symbol') return { symbolName: args.symbolName, repo: args.repo };
  if (tool === 'ctx_links')
    return { group: args.group, refs: args.refs, all_repos: args.all_repos };
  return Object.fromEntries(
    Object.entries(args).filter(([key]) =>
      /repo|project|group|path|ref|symbol|terms|relationship|source|target|from|to|query|prompt|name/i.test(
        key
      )
    )
  );
}

function runMcpProxy() {
  const group = process.env.CONTEXTOS_AGENT_GROUP;
  const serverHome = process.env.CONTEXTOS_AGENT_SERVER_HOME;
  if (!group || !serverHome)
    throw new Error('MCP proxy is missing its fixture group or private home.');
  const child = spawn(process.execPath, [CONTEXTOS_ENTRY, 'serve', '--group', group], {
    cwd: process.env.CONTEXTOS_REPO_ROOT || REPO_ROOT,
    env: {
      ...process.env,
      HOME: serverHome,
      USERPROFILE: serverHome,
      XDG_CONFIG_HOME: path.join(serverHome, '.config'),
      XDG_DATA_HOME: path.join(serverHome, '.local', 'share'),
      XDG_STATE_HOME: path.join(serverHome, '.local', 'state'),
      CONTEXTOS_AUTO_PATCH_REEXEC: '1',
      CONTEXTOS_EMBEDDINGS: '0'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let clientBuffer = '';
  let serverBuffer = '';
  const pending = new Map();
  const client = process.env.CONTEXTOS_AGENT_CLIENT ?? 'unknown';
  const phase = process.env.CONTEXTOS_AGENT_PHASE ?? 'unknown';
  const restrictLink = process.env.CONTEXTOS_AGENT_RESTRICT_LINK === '1';

  process.stdin.on('data', (chunk) => {
    clientBuffer += chunk.toString('utf8');
    let end;
    while ((end = clientBuffer.indexOf('\n')) >= 0) {
      const line = clientBuffer.slice(0, end);
      clientBuffer = clientBuffer.slice(end + 1);
      try {
        const request = JSON.parse(line);
        if (request.method === 'tools/call') {
          const tool = request.params?.name ?? 'unknown';
          const args = proxyToolArgs(tool, request.params?.arguments);
          pending.set(String(request.id), tool);
          appendEvent({ kind: 'mcp_call', id: String(request.id), client, phase, tool, args });
          if (restrictLink && tool === 'ctx_link') {
            const message =
              'ctx_link is denied by the restrictive noninteractive release-test profile.';
            const reply = {
              jsonrpc: '2.0',
              id: request.id,
              result: { isError: true, content: [{ type: 'text', text: message }] }
            };
            process.stdout.write(`${JSON.stringify(reply)}\n`);
            appendEvent({
              kind: 'mcp_result',
              id: String(request.id),
              client,
              phase,
              tool,
              isError: true,
              text: message,
              structured: null
            });
            pending.delete(String(request.id));
            continue;
          }
        }
      } catch {
        appendEvent({ kind: 'mcp_protocol_unparsed', client, phase, side: 'client' });
      }
      child.stdin.write(`${line}\n`);
    }
  });
  process.stdin.on('end', () => child.stdin.end());
  child.stdin.on('error', () => {});

  child.stdout.on('data', (chunk) => {
    serverBuffer += chunk.toString('utf8');
    let end;
    while ((end = serverBuffer.indexOf('\n')) >= 0) {
      const line = serverBuffer.slice(0, end);
      serverBuffer = serverBuffer.slice(end + 1);
      try {
        const response = JSON.parse(line);
        if (restrictLink && response.result?.tools && Array.isArray(response.result.tools)) {
          response.result.tools = response.result.tools.filter((tool) => tool.name !== 'ctx_link');
          process.stdout.write(`${JSON.stringify(response)}\n`);
        } else {
          process.stdout.write(`${line}\n`);
        }
        if (Array.isArray(response.result?.tools)) {
          appendEvent({
            kind: 'mcp_tools',
            client,
            phase,
            tools: response.result.tools.map((tool) => tool.name)
          });
        }
        const key = String(response.id ?? '');
        const tool = pending.get(key);
        if (tool) {
          const result = response.result;
          const textParts = (result?.content ?? [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text)
            .join('\n')
            .slice(0, 18000);
          appendEvent({
            kind: 'mcp_result',
            id: key,
            client,
            phase,
            tool,
            isError: Boolean(response.error || result?.isError),
            text: textParts,
            structured: result?.structuredContent ?? null
          });
          pending.delete(key);
        }
      } catch {
        appendEvent({ kind: 'mcp_protocol_unparsed', client, phase, side: 'server' });
        process.stdout.write(`${line}\n`);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    appendEvent({ kind: 'mcp_server_stderr', client, phase, bytes: Buffer.byteLength(chunk) });
  });
  child.on('exit', (code, signal) => {
    appendEvent({ kind: 'mcp_server_exit', client, phase, code, signal });
    process.exitCode = code ?? (signal ? 1 : 0);
  });
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  process.on('SIGINT', () => child.kill('SIGINT'));
}

async function runWithTimeout(command, args, options, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let stdoutBuffer = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 4000);
      force.unref();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      fs.appendFileSync(
        path.join(
          RUN_ROOT,
          `${options.env.CONTEXTOS_AGENT_CLIENT}-${options.env.CONTEXTOS_AGENT_PHASE}.stdout.jsonl`
        ),
        text
      );
      stdoutBuffer += text;
      let end;
      while ((end = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, end);
        stdoutBuffer = stdoutBuffer.slice(end + 1);
        if (!line.trim()) continue;
        const { records } = parseJsonLines(line);
        for (const record of records) {
          for (const event of collectAgentActions(record)) {
            appendEvent({
              ...event,
              kind: 'agent_action',
              actionKind: event.kind,
              client: options.env.CONTEXTOS_AGENT_CLIENT,
              phase: options.env.CONTEXTOS_AGENT_PHASE
            });
          }
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      appendEvent({
        kind: 'agent_stderr',
        client: options.env.CONTEXTOS_AGENT_CLIENT,
        phase: options.env.CONTEXTOS_AGENT_PHASE,
        bytes: Buffer.byteLength(text)
      });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, error: error.message });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (stdoutBuffer.trim()) {
        const { records } = parseJsonLines(stdoutBuffer);
        for (const record of records) {
          for (const event of collectAgentActions(record)) {
            appendEvent({
              ...event,
              kind: 'agent_action',
              actionKind: event.kind,
              client: options.env.CONTEXTOS_AGENT_CLIENT,
              phase: options.env.CONTEXTOS_AGENT_PHASE
            });
          }
        }
      }
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function getClientStatus(client) {
  let result;
  if (client === 'codex') {
    result = spawnSync('codex', ['login', 'status'], { encoding: 'utf8', timeout: 10000 });
    return {
      authenticated: result.status === 0 && /logged in/i.test(`${result.stdout}\n${result.stderr}`),
      statusCode: result.status
    };
  }
  if (client === 'claude') {
    result = spawnSync('claude', ['auth', 'status', '--json'], {
      encoding: 'utf8',
      timeout: 10000
    });
    try {
      const data = JSON.parse(result.stdout);
      return { authenticated: Boolean(data.loggedIn), statusCode: result.status };
    } catch {
      return { authenticated: false, statusCode: result.status };
    }
  }
  result = spawnSync('grok', ['models'], { encoding: 'utf8', timeout: 10000 });
  return {
    authenticated: result.status === 0 && !/not authenticated/i.test(result.stdout),
    statusCode: result.status
  };
}

function mcpNames() {
  return [
    'get_context',
    'ctx_scope',
    'ctx_read_file',
    'ctx_expand',
    'ctx_symbol',
    'ctx_trace',
    'ctx_resolve_import',
    'ctx_links',
    'ctx_link',
    'reindex_context'
  ];
}

function launchSpec(client, phase, prompt, fixture, restrictive = false) {
  const home = privateServerHome(client);
  const group = `fresh-agent-release-${client}`;
  const proxyEnv = {
    CONTEXTOS_REPO_ROOT: fixture,
    CONTEXTOS_AGENT_CLIENT: client,
    CONTEXTOS_AGENT_PHASE: phase,
    CONTEXTOS_AGENT_SERVER_HOME: home,
    CONTEXTOS_AGENT_GROUP: group,
    CONTEXTOS_AUDIT_PATH: EVENT_PATH
  };
  if (restrictive) proxyEnv.CONTEXTOS_AGENT_RESTRICT_LINK = '1';
  const deadline = Number(process.env.FRESH_AGENT_TIMEOUT_MS ?? 120000);
  const common = { cwd: fixture, env: { ...process.env, ...proxyEnv } };
  if (client === 'codex') {
    const args = [
      'exec',
      '--json',
      '--ephemeral',
      '--ignore-user-config',
      '--cd',
      fixture,
      '--sandbox',
      'read-only',
      '-c',
      'approval_policy="never"',
      '-c',
      `mcp_servers.contextos.command=${JSON.stringify(process.execPath)}`,
      '-c',
      `mcp_servers.contextos.args=${JSON.stringify([path.join(REPO_ROOT, 'scripts', 'agent-release-test.mjs'), '--mcp-proxy'])}`,
      '-c',
      `mcp_servers.contextos.env.HOME=${JSON.stringify(home)}`,
      '-c',
      `mcp_servers.contextos.env.USERPROFILE=${JSON.stringify(home)}`,
      '-c',
      `mcp_servers.contextos.env.CONTEXTOS_AGENT_CLIENT=${JSON.stringify(client)}`,
      '-c',
      `mcp_servers.contextos.env.CONTEXTOS_AGENT_PHASE=${JSON.stringify(phase)}`,
      '-c',
      `mcp_servers.contextos.env.CONTEXTOS_AGENT_SERVER_HOME=${JSON.stringify(home)}`,
      '-c',
      `mcp_servers.contextos.env.CONTEXTOS_AGENT_GROUP=${JSON.stringify(group)}`,
      '-c',
      `mcp_servers.contextos.env.CONTEXTOS_REPO_ROOT=${JSON.stringify(fixture)}`,
      '-c',
      `mcp_servers.contextos.env.CONTEXTOS_AUDIT_PATH=${JSON.stringify(EVENT_PATH)}`,
      '-c',
      'model_reasoning_effort="low"'
    ];
    args.push(prompt);
    return { command: 'codex', args, options: common, timeoutMs: deadline };
  }

  const contextosToolAllowList = mcpNames().map((name) => `mcp__contextos__${name}`);
  if (client === 'claude') {
    const configPath = path.join(RUN_ROOT, `${client}-${phase}.mcp.json`);
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            contextos: {
              command: process.execPath,
              args: [path.join(REPO_ROOT, 'scripts', 'agent-release-test.mjs'), '--mcp-proxy'],
              env: proxyEnv
            }
          }
        },
        null,
        2
      )
    );
    const args = [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--setting-sources',
      'project,local',
      '--strict-mcp-config',
      '--mcp-config',
      configPath,
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      ...contextosToolAllowList,
      '--tools',
      'Read'
    ];
    if (restrictive) args.splice(args.indexOf('mcp__contextos__ctx_link'), 1);
    return { command: 'claude', args, options: common, timeoutMs: deadline };
  }

  const configDir = path.join(fixture, '.grok');
  fs.mkdirSync(configDir, { recursive: true });
  const toml = [
    '[mcp_servers.contextos]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(path.join(REPO_ROOT, 'scripts', 'agent-release-test.mjs'))}, "--mcp-proxy"]`,
    `env = { ${Object.entries(proxyEnv)
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
      .join(', ')} }`,
    'enabled = true',
    '',
    '[permission]',
    'allow = ["MCPTool(contextos__*)"]',
    'deny = ["Bash", "Shell", "Write", "Edit"]',
    ''
  ].join('\n');
  fs.writeFileSync(path.join(configDir, 'config.toml'), toml);
  const args = [
    '--single',
    prompt,
    '--output-format',
    'streaming-messages-json',
    '--max-turns',
    '6',
    '--no-subagents',
    '--disable-web-search',
    '--permission-mode',
    'dontAsk'
  ];
  return { command: 'grok', args, options: common, timeoutMs: deadline };
}

function runAgent(client, phase, prompt, fixture, restrictive = false) {
  const spec = launchSpec(client, phase, prompt, fixture, restrictive);
  return runWithTimeout(spec.command, spec.args, spec.options, spec.timeoutMs);
}

function setProjectInstructionFiles(workspace) {
  // Install the branch's real managed blocks after global setup support is available.
  const api = path.join(workspace, 'payment-api');
  const rootAgents = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8');
  const managed = rootAgents.match(
    /<!-- contextos:managed:start -->[\s\S]*?<!-- contextos:managed:end -->/i
  )?.[0];
  if (!managed)
    throw new Error('The checkout has no managed instruction block to install in the fixture.');
  fs.writeFileSync(path.join(api, 'AGENTS.md'), `${managed}\n`);
  fs.writeFileSync(path.join(api, 'CLAUDE.md'), '@AGENTS.md\n');
}

function redactStatus(client, status) {
  return { client, authenticated: status.authenticated, statusCode: status.statusCode };
}

async function runRelease() {
  if (!fs.existsSync(path.join(RUN_ROOT, 'workspace.path'))) prepare();
  const workspace = fs.readFileSync(path.join(RUN_ROOT, 'workspace.path'), 'utf8').trim();
  const fixture = path.join(workspace, 'payment-api');
  const statuses = Object.fromEntries(CLIENTS.map((client) => [client, getClientStatus(client)]));
  const results = [];

  const runnable = [];
  for (const client of CLIENTS) {
    const auth = statuses[client];
    if (!auth.authenticated) {
      results.push({
        client,
        status: 'blocked',
        reason: 'native authentication is not available',
        auth: redactStatus(client, auth)
      });
      continue;
    }
    const init = await initializeFixtureGroup(client, workspace);
    if (!init.ok) {
      results.push({
        client,
        status: 'failed',
        reason: 'fixture project registration/indexing failed',
        detail: init.detail,
        auth: redactStatus(client, auth)
      });
      continue;
    }
    const initial = await runAgent(client, 'initial', ARCHITECTURE_QUESTION, fixture);
    const initialEvents = readEvents();
    const hasLink = initialEvents.some(
      (event) =>
        event.kind === 'mcp_call' &&
        event.client === client &&
        event.phase === 'initial' &&
        event.tool === 'ctx_link'
    );
    const restrictive = hasLink
      ? await runAgent(client, 'restrictive', ARCHITECTURE_QUESTION, fixture, true)
      : { code: null, skipped: 'no link was requested' };
    const reuse = hasLink
      ? await runAgent(client, 'reuse', REUSE_QUESTION, fixture)
      : { code: null, skipped: 'no link was requested' };
    runnable.push({ client, hasLink });
    results.push({
      client,
      status: 'ran',
      auth: redactStatus(client, auth),
      phases: {
        initial: { code: initial.code, signal: initial.signal, timedOut: initial.timedOut },
        restrictive: {
          code: restrictive.code,
          signal: restrictive.signal,
          timedOut: restrictive.timedOut,
          skipped: restrictive.skipped
        },
        reuse: {
          code: reuse.code,
          signal: reuse.signal,
          timedOut: reuse.timedOut,
          skipped: reuse.skipped
        },
        invalidation: {
          code: null,
          skipped: hasLink ? 'scheduled after evidence edit and reindex' : 'no link was requested'
        }
      }
    });
  }

  const evidenceInvalidation = await mutateAndReindex(workspace, runnable);
  for (const entry of runnable.filter((candidate) => candidate.hasLink)) {
    const invalidation = await runAgent(
      entry.client,
      'invalidation',
      INVALIDATION_QUESTION,
      fixture
    );
    const result = results.find((candidate) => candidate.client === entry.client);
    result.phases.invalidation = {
      code: invalidation.code,
      signal: invalidation.signal,
      timedOut: invalidation.timedOut
    };
  }

  const events = readEvents();
  const report = {
    generatedAt: new Date().toISOString(),
    checkout: {
      root: REPO_ROOT,
      branch: process.env.GIT_BRANCH ?? 'codex/verified-cross-project-tracing'
    },
    fixture: { root: RUN_ROOT, workspace, repos: REPOS.map((repo) => repo.name) },
    budgets: {
      timeoutMs: Number(process.env.FRESH_AGENT_TIMEOUT_MS ?? 120000),
      maxTurns: { claude: 6, grok: 6, codex: 'external timeout' }
    },
    clients: results,
    protocol: evaluateProtocol({
      mcpEvents: events.filter((event) =>
        ['mcp_call', 'mcp_result', 'mcp_tools'].includes(event.kind)
      ),
      agentEvents: events.filter((event) => event.kind === 'agent_action')
    }),
    evidenceInvalidation
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

async function initializeFixtureGroup(client, workspace) {
  const serverHome = privateServerHome(client);
  const group = `fresh-agent-release-${client}`;
  const env = {
    ...process.env,
    HOME: serverHome,
    USERPROFILE: serverHome,
    XDG_CONFIG_HOME: path.join(serverHome, '.config'),
    XDG_DATA_HOME: path.join(serverHome, '.local', 'share'),
    XDG_STATE_HOME: path.join(serverHome, '.local', 'state')
  };
  const details = [];
  const created = spawnSync(process.execPath, [CONTEXTOS_ENTRY, 'group', 'create', group], {
    cwd: workspace,
    env: { ...env, CONTEXTOS_EMBEDDINGS: '0', CONTEXTOS_AUTO_PATCH_REEXEC: '1' },
    encoding: 'utf8',
    timeout: 20000
  });
  if (created.status !== 0)
    return { ok: false, detail: [{ step: 'create-group', code: created.status }] };
  for (const repo of REPOS) {
    const repoPath = path.join(workspace, repo.name);
    const result = spawnSync(
      process.execPath,
      [CONTEXTOS_ENTRY, 'init', '--name', repo.name, '--group', group, '--json', repoPath],
      {
        cwd: repoPath,
        env: { ...env, CONTEXTOS_EMBEDDINGS: '0', CONTEXTOS_AUTO_PATCH_REEXEC: '1' },
        encoding: 'utf8',
        timeout: 90000
      }
    );
    let json = null;
    try {
      json = JSON.parse(result.stdout);
    } catch {}
    details.push({
      repo: repo.name,
      code: result.status,
      status: json?.status,
      error: result.error?.message
    });
    if (result.status !== 0) return { ok: false, detail: details };
  }
  return { ok: true, detail: details };
}

function readEvents() {
  if (!fs.existsSync(EVENT_PATH)) return [];
  return parseJsonLines(fs.readFileSync(EVENT_PATH, 'utf8')).records;
}

export function classifyBlockedSession(transcript) {
  for (const record of parseJsonLines(transcript).records) {
    const item = record.item;
    if (
      item?.type === 'mcp_tool_call' &&
      /requires approval.*policy is never/i.test(item.error?.message ?? '')
    )
      return 'Native noninteractive approval policy blocked MCP calls; no client permission was changed.';
    if (
      record.type === 'error' &&
      /usage limit|rate limit|quota|credits/i.test(record.message ?? '')
    )
      return 'Native client usage or billing limit prevented the session.';
  }
  return null;
}

function finalizeReport(report) {
  const events = readEvents();
  for (const item of report.clients) {
    const relevant = events.filter((event) => event.client === item.client);
    item.checks = evaluateProtocol({
      mcpEvents: relevant.filter((event) => event.kind.startsWith('mcp_')),
      agentEvents: relevant.filter((event) => event.kind === 'agent_action')
    });
    if (!item.phases) continue;
    const transcript = path.join(RUN_ROOT, `${item.client}-initial.stdout.jsonl`);
    const blocked = fs.existsSync(transcript)
      ? classifyBlockedSession(fs.readFileSync(transcript, 'utf8'))
      : null;
    const checks = item.checks;
    const success =
      checks.retrievalBeforeBroadSearch &&
      checks.correctLinkSaved &&
      !checks.misleadingLegacyLinkSaved &&
      checks.reusedInNewSession &&
      checks.evidenceInvalidationChecked &&
      report.evidenceInvalidation.outcomes.some(
        (outcome) => outcome.client === item.client && outcome.code === 0
      );
    item.status = blocked ? 'blocked' : success ? 'passed' : 'failed';
    item.reason =
      blocked ??
      (success
        ? undefined
        : 'One or more fresh-session release checks did not pass; inspect protocol evidence.');
  }
  report.releaseReady =
    report.clients.length === CLIENTS.length &&
    report.clients.every((item) => item.status === 'passed');
  report.protocol = evaluateProtocol({
    mcpEvents: events.filter((event) => event.kind.startsWith('mcp_')),
    agentEvents: events.filter((event) => event.kind === 'agent_action')
  });
  report.cleanup = stopFixtureDaemons();
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeMarkdownReport(report);
  return report;
}

async function mutateAndReindex(workspace, runnable) {
  const store = path.join(workspace, 'pg-store');
  const evidenceFile = path.join(store, 'src', 'captures.ts');
  fs.appendFileSync(
    evidenceFile,
    '\n// Release-test evidence edit: forces a fresh generation after the saved relationship.\n'
  );
  const outcomes = [];
  for (const { client, hasLink } of runnable) {
    if (!hasLink) continue;
    if (!fs.existsSync(privateServerHome(client))) continue;
    const env = {
      ...process.env,
      HOME: privateServerHome(client),
      USERPROFILE: privateServerHome(client),
      XDG_CONFIG_HOME: path.join(privateServerHome(client), '.config'),
      XDG_DATA_HOME: path.join(privateServerHome(client), '.local', 'share'),
      XDG_STATE_HOME: path.join(privateServerHome(client), '.local', 'state')
    };
    const result = spawnSync(
      process.execPath,
      [CONTEXTOS_ENTRY, 'reindex', '--group', `fresh-agent-release-${client}`],
      {
        cwd: store,
        env,
        encoding: 'utf8',
        timeout: 90000
      }
    );
    outcomes.push({ client, code: result.status, error: result.error?.message });
  }
  return { fileEdited: 'pg-store/src/captures.ts', outcomes };
}

function writeMarkdownReport(report) {
  const rows = report.clients
    .map((item) => `| ${item.client} | ${item.status} | ${item.reason ?? ''} |`)
    .join('\n');
  const protocol = report.protocol ?? {};
  const content = `# Fresh-session agent release gate\n\nGenerated ${report.generatedAt}. The same architecture question is issued to each authenticated native CLI from a new non-interactive session.\n\n| Client | Status | Detail |\n| --- | --- | --- |\n${rows}\n\nProtocol checks: retrieval before broad search: ${protocol.retrievalBeforeBroadSearch}; broad search observed: ${protocol.broadSearchObserved}; correct relationship saved: ${protocol.correctLinkSaved}; misleading legacy relationship saved: ${protocol.misleadingLegacyLinkSaved}; reuse in a later session: ${protocol.reusedInNewSession}; evidence invalidation checked: ${protocol.evidenceInvalidationChecked}.\n\nFixture repos: ${report.fixture.repos.join(', ')}. Client transcripts, MCP audit events, and isolated server state are under \`.tmp/fresh-agent-release/\`. No client credentials or source from this checkout are stored in the report.\n`;
  fs.writeFileSync(path.join(REPO_ROOT, 'validation', 'fresh-agent-sessions.md'), content);
}

function parseArgs(args) {
  const flags = new Set(args);
  return {
    prepare: flags.has('--prepare'),
    run: flags.has('--run'),
    report: flags.has('--report'),
    proxy: flags.has('--mcp-proxy')
  };
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.proxy) return runMcpProxy();
  if (flags.prepare) {
    const result = prepare();
    process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return;
  }
  if (flags.run) {
    const result = finalizeReport(await runRelease());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.releaseReady) process.exitCode = 1;
    return;
  }
  if (flags.report) {
    const result = finalizeReport(JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.releaseReady) process.exitCode = 1;
    return;
  }
  process.stdout.write('Usage: node scripts/agent-release-test.mjs --prepare | --run\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
