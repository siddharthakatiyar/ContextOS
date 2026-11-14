import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { DoctorCheck } from '../commands/doctor.js';

export const DIAGNOSTIC_CLIENTS = [
  'codex',
  'claude',
  'grok',
  'opencode',
  'agy',
  'antigravity',
  'gemini',
  'cursor',
  'cline',
  'roo',
  'windsurf'
] as const;
export type DiagnosticClient = (typeof DIAGNOSTIC_CLIENTS)[number];
type JsonObject = Record<string, unknown>;
type Permission = 'allowed' | 'denied' | 'approval-required' | 'unknown';
interface ConfigFile {
  path: string;
  data?: JsonObject;
  error?: boolean;
}
interface Server {
  name: string;
  config: ConfigFile;
  data: JsonObject;
}
const READ_TOOLS = [
  'get_context',
  'ctx_scope',
  'ctx_expand',
  'ctx_read_file',
  'ctx_symbol',
  'ctx_trace',
  'ctx_resolve_import',
  'ctx_contract',
  'ctx_links'
];
const WRITE_TOOLS = ['ctx_remember', 'ctx_link', 'ctx_forget', 'ctx_unlink'];
const record = (value: unknown): value is JsonObject =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
function canonical(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

/** Diagnose the persisted selection without registry constructors, migrations, or discovery writes. */
export function inspectRegisteredScope(root: string, homeDirectory: string): DoctorCheck[] {
  const file = path.join(homeDirectory, '.contextos', 'registry.db');
  const unknown = (summary: string): DoctorCheck[] => [
    { id: 'agent-scope', status: 'unknown', summary, details: { path: file } },
    {
      id: 'agent-readiness',
      status: 'unknown',
      summary: 'Registered view readiness is unavailable'
    }
  ];
  if (!fs.existsSync(file))
    return unknown(
      'No global project registry is present; register this project with contextos init'
    );
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 500 });
    db.pragma('query_only = ON');
    const columns = new Set(
      (db.prepare('PRAGMA table_info(repositories)').all() as { name: string }[]).map((c) => c.name)
    );
    const selectedColumns = [
      'id',
      'project_id',
      'worktree_id',
      'name',
      'root_path',
      'branch',
      'head',
      'active',
      'state',
      'generation',
      'checkout_generation'
    ].filter((c) => columns.has(c));
    if (!columns.has('root_path'))
      return unknown('The project registry schema cannot be inspected by this doctor');
    const rows = db
      .prepare(`SELECT ${selectedColumns.join(', ')} FROM repositories`)
      .all() as JsonObject[];
    const matches = rows
      .filter(
        (row) =>
          typeof row.root_path === 'string' &&
          (root === canonical(row.root_path) ||
            root.startsWith(canonical(row.root_path) + path.sep)) &&
          row.active !== 0
      )
      .sort((a, b) => String(b.root_path).length - String(a.root_path).length);
    const row = matches[0];
    if (!row)
      return unknown(
        'This directory has no active registered project/worktree view; run contextos init in the project'
      );
    if (matches[1]?.root_path === row.root_path)
      return unknown('Multiple active views match this worktree; the selected view is ambiguous');
    let branch: string | null | undefined;
    let head: string | undefined;
    try {
      const value = execFileSync('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000
      }).trim();
      branch = value === 'HEAD' ? null : value;
      head = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000
      }).trim();
    } catch {
      /* Non-Git projects remain valid registered projects. */
    }
    const stale =
      branch !== undefined && (row.branch !== branch || (head !== undefined && row.head !== head));
    return [
      {
        id: 'agent-scope',
        status: stale ? 'warn' : 'pass',
        summary: stale
          ? 'The registered view differs from the current checkout; refresh project registration before relying on its selection'
          : `Registered project ${String(row.name ?? row.project_id ?? '')}, worktree ${String(row.root_path)}, branch ${String(row.branch ?? '(detached or non-Git)')}`,
        details: {
          projectId: row.project_id ?? null,
          worktreeId: row.worktree_id ?? null,
          viewId: row.id ?? null,
          rootPath: row.root_path,
          registeredBranch: row.branch ?? null,
          registeredHead: row.head ?? null,
          currentBranch: branch ?? null,
          currentHead: head ?? null,
          checkoutGeneration: row.checkout_generation ?? null
        }
      },
      {
        id: 'agent-readiness',
        status: stale
          ? 'warn'
          : row.state === 'ready' && Number(row.generation) > 0
            ? 'pass'
            : row.state === 'failed' || row.state === 'error'
              ? 'fail'
              : 'unknown',
        summary: `Registered view reports ${String(row.state ?? 'unknown')} (index generation ${String(row.generation ?? 'unknown')}); index and daemon checks provide separate evidence`,
        details: { state: row.state ?? null, generation: row.generation ?? null }
      }
    ];
  } catch {
    return unknown(
      'The global project registry cannot be read safely; no migration or repair was attempted'
    );
  } finally {
    db?.close();
  }
}

function clientPaths(
  client: DiagnosticClient,
  root: string,
  home: string
): { instruction: string; globalInstruction: string; configs: string[] } {
  const globalBase =
    client === 'codex'
      ? process.env.CODEX_HOME || path.join(home, '.codex')
      : client === 'claude'
        ? process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
        : client === 'opencode'
          ? path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode')
          : client === 'windsurf'
            ? path.join(home, '.codeium', 'windsurf')
            : path.join(
                home,
                client === 'agy' || client === 'antigravity' ? '.gemini' : `.${client}`
              );
  const instruction =
    client === 'claude'
      ? 'CLAUDE.md'
      : client === 'gemini' || client === 'agy' || client === 'antigravity'
        ? 'GEMINI.md'
        : 'AGENTS.md';
  const globalConfig =
    client === 'codex' || client === 'grok'
      ? 'config.toml'
      : client === 'opencode'
        ? 'opencode.json'
        : client === 'agy' || client === 'antigravity'
          ? path.join('config', 'mcp_config.json')
          : client === 'claude'
            ? 'settings.json'
            : client === 'gemini'
              ? 'settings.json'
              : client === 'windsurf'
                ? 'mcp_config.json'
                : 'mcp.json';
  const configs = [path.join(globalBase, globalConfig)];
  if (client === 'codex' || client === 'grok')
    configs.push(path.join(root, `.${client}`, 'config.toml'));
  else if (client === 'claude')
    configs.push(
      path.join(home, '.claude.json'),
      path.join(root, '.mcp.json'),
      path.join(root, '.claude', 'settings.json'),
      path.join(root, '.claude', 'settings.local.json')
    );
  else if (client === 'opencode')
    configs.push(
      path.join(globalBase, 'opencode.jsonc'),
      path.join(root, 'opencode.json'),
      path.join(root, 'opencode.jsonc')
    );
  else if (client === 'gemini') configs.push(path.join(root, '.gemini', 'settings.json'));
  else if (client === 'agy' || client === 'antigravity')
    configs.push(path.join(root, '.agents', 'mcp_config.json'));
  else if (client === 'cursor') configs.push(path.join(root, '.cursor', 'mcp.json'));
  else if (client === 'cline' || client === 'roo')
    configs.push(path.join(root, '.vscode', `${client}_mcp_settings.json`));
  return {
    instruction,
    globalInstruction:
      client === 'windsurf'
        ? path.join(globalBase, 'memories', 'global_rules.md')
        : path.join(globalBase, instruction),
    configs
  };
}

/** Remove JSONC comments outside strings; never evaluate client configuration. */
function jsonc(contents: string): string {
  let result = '';
  let quoted = false;
  let escaped = false;
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i];
    if (quoted) {
      result += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
      continue;
    }
    if (c === '"') {
      quoted = true;
      result += c;
    } else if (c === '/' && contents[i + 1] === '/') {
      while (i < contents.length && contents[i] !== '\n') i++;
      result += '\n';
    } else if (c === '/' && contents[i + 1] === '*') {
      i += 2;
      while (i < contents.length && !(contents[i] === '*' && contents[i + 1] === '/')) i++;
      i++;
      result += ' ';
    } else result += c;
  }
  return result;
}
/** Split TOML inline values without splitting strings or nested tables/arrays. */
function inlineParts(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: string | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === '"' && character === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '[' || character === '{') depth++;
    else if (character === ']' || character === '}') depth--;
    else if (character === ',' && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}
function tomlValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    /* Continue with TOML-only values. */
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('[') && value.endsWith(']')) {
    const result = inlineParts(value.slice(1, -1)).map(tomlValue);
    return result.every((item) => item !== undefined) ? result : undefined;
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const result: JsonObject = Object.create(null);
    for (const part of inlineParts(value.slice(1, -1))) {
      const match = part.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)\s*=\s*(.*)$/);
      if (!match) return undefined;
      const key =
        match[1].startsWith('"') || match[1].startsWith("'") ? tomlValue(match[1]) : match[1];
      const parsed = tomlValue(match[2].trim());
      if (typeof key !== 'string' || parsed === undefined) return undefined;
      result[key] = parsed;
    }
    return result;
  }
  return undefined;
}
function trailingCommas(value: string): string {
  let result = '';
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (quoted) {
      result += character;
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    if (character === ',') {
      let next = index + 1;
      while (/\s/.test(value[next] ?? '') && next < value.length) next++;
      if (value[next] === ']' || value[next] === '}') continue;
    }
    result += character;
  }
  return result;
}
function readConfig(file: string): ConfigFile {
  if (!fs.existsSync(file)) return { path: file };
  try {
    if (fs.statSync(file).size > 1024 * 1024) return { path: file, error: true };
    const contents = fs.readFileSync(file, 'utf8');
    if (!file.endsWith('.toml')) {
      const data: unknown = JSON.parse(trailingCommas(jsonc(contents)));
      return record(data) ? { path: file, data } : { path: file, error: true };
    }
    // Only the scalar/array subset relevant to MCP diagnostics is observed.
    const data: JsonObject = Object.create(null);
    let partial = false;
    let section = data;
    for (const line of contents.split(/\r?\n/)) {
      const clean = line.trim();
      if (!clean || clean.startsWith('#')) continue;
      const header = clean.match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
      if (header) {
        section = data;
        for (const part of header[1].match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^.]+/g) ?? []) {
          const key = part.trim().replace(/^["']|["']$/g, '');
          if (!Object.hasOwn(section, key) || !record(section[key]))
            section[key] = Object.create(null);
          section = section[key] as JsonObject;
        }
        continue;
      }
      const match = clean.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let quoted: string | undefined;
      let escaped = false;
      let end = match[2].length;
      for (let index = 0; index < match[2].length; index++) {
        const character = match[2][index];
        if (escaped) {
          escaped = false;
          continue;
        }
        if (quoted === '"' && character === '\\') {
          escaped = true;
          continue;
        }
        if (quoted) {
          if (character === quoted) quoted = undefined;
        } else if (character === '"' || character === "'") quoted = character;
        else if (character === '#') {
          end = index;
          break;
        }
      }
      const raw = match[2].slice(0, end).trim();
      const parsed = tomlValue(raw);
      if (parsed !== undefined) section[match[1]] = parsed;
      else if (
        /^(?:enabled|disabled|enabled_tools|disabled_tools|default_tools_approval_mode|approval_mode|get_context|ctx_.*)$/.test(
          match[1]
        )
      )
        partial = true;
    }
    return { path: file, data, ...(partial ? { error: true } : {}) };
  } catch {
    return { path: file, error: true };
  }
}
function contextServers(config: ConfigFile, root: string): Server[] {
  if (!config.data) return [];
  const sources: JsonObject[] = [config.data];
  const projects = config.data.projects;
  if (record(projects)) {
    const entry = projects[root];
    if (record(entry)) sources.push(entry);
  }
  return sources.flatMap((source) => {
    const mcp = source.mcp;
    const servers =
      source.mcpServers ??
      source.mcp_servers ??
      (record(mcp) && record(mcp.servers) ? mcp.servers : mcp);
    if (!record(servers)) return [];
    return Object.entries(servers)
      .filter(
        ([name, entry]) =>
          record(entry) &&
          (name === 'contextos' ||
            name.startsWith('contextos-') ||
            (record(entry.env) &&
              ('CONTEXTOS_REPO_ROOT' in entry.env || 'CONTEXTOS_WORKSPACE' in entry.env)) ||
            /(?:^|[\s/@])contextos(?:[\s/.@-]|$)/i.test(
              [
                ...(typeof entry.command === 'string' ? [entry.command] : strings(entry.command)),
                ...strings(entry.args)
              ].join(' ')
            ))
      )
      .map(([name, data]) => ({ name, data: data as JsonObject, config }));
  });
}

function inspectInstructions(
  client: DiagnosticClient | undefined,
  root: string,
  home: string
): DoctorCheck {
  const spec = client
    ? clientPaths(client, root, home)
    : {
        instruction: 'AGENTS.md',
        globalInstruction: path.join(
          process.env.CODEX_HOME || path.join(home, '.codex'),
          'AGENTS.md'
        )
      };
  const globalOverride = path.join(path.dirname(spec.globalInstruction), 'AGENTS.override.md');
  const candidates = [
    client === 'codex' && fs.existsSync(globalOverride) ? globalOverride : spec.globalInstruction
  ];
  const ancestors: string[] = [];
  let directory = root;
  while (true) {
    ancestors.unshift(directory);
    const parent = path.dirname(directory);
    if (directory === parent) break;
    directory = parent;
  }
  for (const ancestor of ancestors) {
    if (client === 'codex') {
      const override = path.join(ancestor, 'AGENTS.override.md');
      candidates.push(fs.existsSync(override) ? override : path.join(ancestor, spec.instruction));
    } else candidates.push(path.join(ancestor, spec.instruction));
  }
  if (client === 'claude')
    candidates.push(path.join(root, '.claude', 'CLAUDE.md'), path.join(root, 'CLAUDE.local.md'));
  const files: {
    path: string;
    exists: boolean;
    containsContextOS?: boolean;
    importedBy?: string;
    unreadable?: boolean;
  }[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const visit = (file: string, importedBy?: string, depth = 0) => {
    file = canonical(file);
    if (seen.has(file)) return;
    if (seen.size >= 128 || depth > 8) {
      truncated = true;
      return;
    }
    seen.add(file);
    const entry: (typeof files)[number] = {
      path: file,
      exists: fs.existsSync(file),
      ...(importedBy ? { importedBy } : {})
    };
    files.push(entry);
    if (!entry.exists) return;
    try {
      if (fs.statSync(file).size > 1024 * 1024) {
        entry.unreadable = true;
        truncated = true;
        return;
      }
      const contents = fs.readFileSync(file, 'utf8');
      entry.containsContextOS = /contextos|\bget_context\b/i.test(contents);
      // Static local imports only. Their presence does not prove a running client loaded them.
      for (const match of contents.matchAll(
        /(?:^|\s)@((?:~\/|\.{0,2}\/)?[^\s`<>]+\.(?:md|txt))|\[[^\]]*\]\(([^)\s]+\.(?:md|txt))\)/gm
      )) {
        const target = match[1] ?? match[2];
        if (/^[a-z][a-z\d+.-]*:/i.test(target)) continue;
        visit(
          target.startsWith('~/')
            ? path.join(home, target.slice(2))
            : path.resolve(path.dirname(file), target),
          file,
          depth + 1
        );
      }
    } catch {
      entry.unreadable = true;
    }
  };
  for (const candidate of candidates) visit(candidate);
  const found = files.some((file) => file.containsContextOS);
  return {
    id: 'agent-instructions',
    status: found ? 'pass' : 'warn',
    summary: found
      ? 'ContextOS instructions were found in discoverable instruction files/imports; actual session loading is unknown'
      : 'No ContextOS guidance was found in the inspected instruction files; run contextos init or check the selected client',
    details: {
      client: client ?? 'unspecified (AGENTS.md convention)',
      files,
      staticDiscoveryOnly: true,
      effectiveSessionLoading: 'unknown',
      truncated
    }
  };
}

function globMatch(pattern: string, value: string): boolean {
  return new RegExp(
    `^${pattern
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`
  ).test(value);
}
function toolPermission(
  client: DiagnosticClient,
  server: Server,
  tool: string,
  configs: ConfigFile[]
): Permission {
  const data = server.data;
  if (data.enabled === false || data.disabled === true) return 'denied';
  if (strings(data.disabled_tools).includes(tool) || strings(data.excludeTools).includes(tool))
    return 'denied';
  if (Array.isArray(data.enabled_tools) && !strings(data.enabled_tools).includes(tool))
    return 'denied';
  if (Array.isArray(data.includeTools) && !strings(data.includeTools).includes(tool))
    return 'denied';
  if (client === 'codex') {
    const tools = record(data.tools) ? data.tools : {};
    const override = record(tools[tool]) ? tools[tool] : {};
    const mode = override.approval_mode ?? data.default_tools_approval_mode;
    const autoReviewer =
      data.approvals_reviewer === 'auto_review' || data.approvals_reviewer === 'guardian_subagent';
    if (mode === 'prompt') return autoReviewer ? 'unknown' : 'approval-required';
    if (mode === 'writes' && WRITE_TOOLS.includes(tool))
      return autoReviewer ? 'unknown' : 'approval-required';
    if (mode === 'approve') return 'allowed';
    // auto depends on annotations/runtime policy and cannot establish approval here.
  }
  if (client === 'claude') {
    const name = `mcp__${server.name}__${tool}`;
    const matches = (value: unknown) =>
      strings(value).some((rule) => rule === `mcp__${server.name}` || globMatch(rule, name));
    // A local deny always prevents us from presenting an allow as effective.
    const permissions = configs.flatMap((config) =>
      record(config.data?.permissions) ? [config.data.permissions] : []
    );
    if (permissions.some((p) => matches(p.deny))) return 'denied';
    if (permissions.some((p) => matches(p.ask))) return 'approval-required';
    if (permissions.some((p) => matches(p.allow))) return 'allowed';
  }
  if (client === 'opencode') {
    let result: Permission = 'unknown';
    for (const config of configs) {
      const permission = config.data?.permission;
      if (typeof permission === 'string')
        result =
          permission === 'allow'
            ? 'allowed'
            : permission === 'deny'
              ? 'denied'
              : permission === 'ask'
                ? 'approval-required'
                : 'unknown';
      else if (record(permission)) {
        for (const [pattern, action] of Object.entries(permission))
          if (globMatch(pattern, `${server.name}_${tool}`))
            result =
              action === 'allow'
                ? 'allowed'
                : action === 'deny'
                  ? 'denied'
                  : action === 'ask'
                    ? 'approval-required'
                    : 'unknown';
      }
    }
    return result;
  }
  if (
    (client === 'agy' ||
      client === 'antigravity' ||
      client === 'grok' ||
      client === 'cline' ||
      client === 'roo') &&
    strings(data.autoApprove).includes(tool)
  )
    return 'allowed';
  if (client === 'gemini' && data.trust === true) return 'allowed';
  // approval_policy=never governs prompting and alone says nothing about MCP tool approval.
  return 'unknown';
}

export function inspectAgentDiagnostics(options: {
  root: string;
  homeDirectory: string;
  projectRoot?: string;
  client?: DiagnosticClient;
  noninteractive?: boolean;
}): DoctorCheck[] {
  const { root, homeDirectory: home, client, noninteractive = false } = options;
  const checks = [inspectInstructions(client, root, home)];
  if (!client)
    return [
      ...checks,
      ...[
        'agent-mcp-registration',
        'agent-permissions:retrieval',
        'agent-permissions:knowledge-write'
      ].map((id) => ({
        id,
        status: 'unknown' as const,
        summary:
          'Select --client to inspect client-specific MCP registration and configured permissions',
        details: { client: null, effectiveRuntimePermission: 'unknown' }
      }))
    ];
  const spec = clientPaths(client, options.projectRoot ?? root, home);
  const configs = spec.configs.map(readConfig);
  const servers = configs.flatMap((config) => contextServers(config, options.projectRoot ?? root));
  checks.push({
    id: 'agent-mcp-registration',
    status: configs.some((c) => c.error) ? 'warn' : servers.length ? 'pass' : 'unknown',
    summary: configs.some((c) => c.error)
      ? `Some ${client} configuration could not be parsed; registration and permission observations may be incomplete`
      : servers.length
        ? `ContextOS MCP registration is present for ${client}; session connection remains unknown`
        : `No ContextOS MCP registration was found in the inspected ${client} configuration`,
    details: {
      client,
      inspectedPaths: spec.configs,
      invalidPaths: configs.filter((c) => c.error).map((c) => c.path),
      registrations: servers.map((server) => ({
        path: server.config.path,
        serverName: server.name,
        enabled: server.data.enabled !== false && server.data.disabled !== true
      })),
      effectiveConnection: 'unknown'
    }
  });
  const targets = servers.map((server) => {
    const environment = record(server.data.env)
      ? server.data.env
      : record(server.data.environment)
        ? server.data.environment
        : {};
    const configuredRoot = environment.CONTEXTOS_REPO_ROOT;
    const pinned = typeof configuredRoot === 'string' && path.isAbsolute(configuredRoot);
    return {
      path: server.config.path,
      serverName: server.name,
      configuredRoot: typeof configuredRoot === 'string' ? configuredRoot : null,
      status:
        configuredRoot !== undefined && typeof configuredRoot !== 'string'
          ? 'fail'
          : pinned
            ? canonical(configuredRoot) === canonical(options.projectRoot ?? root)
              ? 'pass'
              : 'fail'
            : 'unknown'
    };
  });
  const mismatched = targets.some((target) => target.status === 'fail');
  checks.push({
    id: 'agent-mcp-target',
    status: mismatched
      ? 'fail'
      : targets.length > 0 && targets.every((target) => target.status === 'pass')
        ? 'pass'
        : 'unknown',
    summary: mismatched
      ? 'A selected client MCP registration pins a different or invalid project root'
      : targets.length > 0 && targets.every((target) => target.status === 'pass')
        ? 'The selected client MCP registration pins this project root'
        : 'MCP launch/session project selection is unknown for registrations without an absolute CONTEXTOS_REPO_ROOT',
    details: { expectedRoot: options.projectRoot ?? root, observations: targets }
  });
  for (const [kind, tools] of [
    ['retrieval', READ_TOOLS],
    ['knowledge-write', WRITE_TOOLS]
  ] as const) {
    const observations = servers.map((server) => ({
      path: server.config.path,
      serverName: server.name,
      tools: Object.fromEntries(
        tools.map((tool) => [tool, toolPermission(client, server, tool, configs)])
      )
    }));
    // Conflicting same-name registrations can be subject to client precedence or trust rules.
    // Retain each observation but do not declare a selected runtime blocker for that conflict.
    const names = [...new Set(observations.map((item) => item.serverName))];
    const values = names.flatMap((name) =>
      tools.map((tool) => {
        const alternatives = observations
          .filter((item) => item.serverName === name)
          .map((item) => item.tools[tool]);
        return alternatives.every((value) => value === alternatives[0])
          ? alternatives[0]
          : 'unknown';
      })
    );
    const denied = values.includes('denied');
    const prompt = values.includes('approval-required');
    const status =
      denied || (prompt && noninteractive)
        ? 'fail'
        : prompt
          ? 'warn'
          : values.length > 0 &&
              values.every((v) => v === 'allowed') &&
              !configs.some((c) => c.error)
            ? 'pass'
            : 'unknown';
    checks.push({
      id: `agent-permissions:${kind}`,
      status,
      summary: denied
        ? `${client} configuration denies at least one ContextOS ${kind} tool; instruction loading cannot bypass it`
        : prompt && noninteractive
          ? `${client} configuration requires approval for ContextOS ${kind}; the requested noninteractive run cannot answer that prompt`
          : prompt
            ? `${client} configuration requires approval for at least one ContextOS ${kind} tool`
            : status === 'pass'
              ? `${client} configuration explicitly allows the inspected ContextOS ${kind} tools; runtime policy is unknown`
              : `${client} ${kind} permissions cannot be established from local configuration; runtime/managed policy may override it`,
      details: {
        client,
        noninteractive,
        observations,
        effectiveRuntimePermission: 'unknown',
        limitation:
          'Read-only configuration observations; no tool was called and no client permission was changed. Runtime, organization, command-line, and managed overrides are not observable.'
      }
    });
  }
  return checks;
}
