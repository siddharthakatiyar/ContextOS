import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { collectDoctorReport } from '../../src/cli/commands/doctor.js';
import { inspectAgentDiagnostics } from '../../src/cli/utils/agent-diagnostics.js';
import { WorkspaceRegistry } from '../../src/core/workspace/registry.js';

const directories: string[] = [];
function directory() {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-doctor-agent-'));
  directories.push(result);
  return result;
}
function write(file: string, content: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}
beforeEach(() => {
  for (const name of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME']) vi.stubEnv(name, '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const file of directories.splice(0)) fs.rmSync(file, { recursive: true, force: true });
});

describe('doctor agent diagnostics', () => {
  it('keeps absent client state unknown and never creates configuration', async () => {
    const root = directory();
    const homeDirectory = path.join(root, 'missing-home');
    const report = await collectDoctorReport({
      cwd: root,
      homeDirectory,
      client: 'codex',
      noninteractive: true
    });
    expect(report.exitCode).toBe(0);
    expect(report.checks.find((c) => c.id === 'agent-scope')?.status).toBe('unknown');
    expect(report.checks.find((c) => c.id === 'agent-mcp-registration')?.status).toBe('unknown');
    expect(report.checks.find((c) => c.id === 'agent-permissions:knowledge-write')?.status).toBe(
      'unknown'
    );
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it('reports instruction files and local imports separately from permission denial', () => {
    const root = directory();
    const homeDirectory = directory();
    write(path.join(homeDirectory, '.claude', 'CLAUDE.md'), 'Use @./contextos.md\n');
    write(
      path.join(homeDirectory, '.claude', 'contextos.md'),
      'Use get_context and ctx_remember.\n'
    );
    write(path.join(root, 'CLAUDE.md'), 'Project instructions\n@./missing.md\n');
    write(path.join(root, '.mcp.json'), {
      mcpServers: { contextos: { command: 'contextos', args: ['serve'] } }
    });
    write(path.join(root, '.claude', 'settings.json'), {
      permissions: {
        allow: ['mcp__contextos__get_context'],
        deny: ['mcp__contextos__ctx_remember']
      }
    });
    const checks = inspectAgentDiagnostics({ root, homeDirectory, client: 'claude' });
    expect(checks.find((c) => c.id === 'agent-instructions')?.status).toBe('pass');
    const files = checks.find((c) => c.id === 'agent-instructions')?.details?.files as {
      path: string;
      importedBy?: string;
      exists: boolean;
    }[];
    expect(files).toContainEqual(
      expect.objectContaining({
        path: path.join(homeDirectory, '.claude', 'contextos.md'),
        importedBy: path.join(homeDirectory, '.claude', 'CLAUDE.md')
      })
    );
    expect(files).toContainEqual(
      expect.objectContaining({ path: path.join(root, 'missing.md'), exists: false })
    );
    const check = checks.find((c) => c.id === 'agent-permissions:knowledge-write');
    expect(check?.status).toBe('fail');
    expect(check?.summary).toContain('instruction loading cannot bypass it');
    expect(check?.details?.effectiveRuntimePermission).toBe('unknown');
  });

  it('treats an approval prompt as a noninteractive blocker and preserves per-tool rules', () => {
    const root = directory();
    const homeDirectory = directory();
    write(path.join(root, '.mcp.json'), { mcpServers: { contextos: { command: 'contextos' } } });
    write(path.join(root, '.claude', 'settings.local.json'), {
      permissions: {
        allow: ['mcp__contextos__*'],
        ask: ['mcp__contextos__ctx_link'],
        deny: ['mcp__contextos__ctx_unlink']
      }
    });
    const checks = inspectAgentDiagnostics({
      root,
      homeDirectory,
      client: 'claude',
      noninteractive: true
    });
    expect(checks.find((c) => c.id === 'agent-permissions:retrieval')?.status).toBe('pass');
    const writes = checks.find((c) => c.id === 'agent-permissions:knowledge-write');
    expect(writes?.status).toBe('fail');
    const observations = writes?.details?.observations as { tools: Record<string, string> }[];
    expect(observations[0].tools).toMatchObject({
      ctx_remember: 'allowed',
      ctx_link: 'approval-required',
      ctx_unlink: 'denied'
    });
    write(path.join(root, '.claude', 'settings.local.json'), {
      permissions: { ask: ['mcp__contextos__*'] }
    });
    const prompt = inspectAgentDiagnostics({
      root,
      homeDirectory,
      client: 'claude',
      noninteractive: true
    }).find((c) => c.id === 'agent-permissions:retrieval');
    expect(prompt?.status).toBe('fail');
    expect(prompt?.summary).toContain('cannot answer that prompt');
    expect(
      inspectAgentDiagnostics({ root, homeDirectory, client: 'claude' }).find(
        (c) => c.id === 'agent-permissions:retrieval'
      )?.status
    ).toBe('warn');
  });

  it('does not infer a blocked MCP tool from Codex approval_policy never', () => {
    const root = directory();
    const homeDirectory = directory();
    write(
      path.join(homeDirectory, '.codex', 'config.toml'),
      'approval_policy = "never"\n[mcp_servers.contextos]\ncommand = "contextos"\nargs = ["serve"]\n'
    );
    const checks = inspectAgentDiagnostics({
      root,
      homeDirectory,
      client: 'codex',
      noninteractive: true
    });
    expect(checks.find((c) => c.id === 'agent-mcp-registration')?.status).toBe('pass');
    expect(checks.find((c) => c.id === 'agent-permissions:retrieval')?.status).toBe('unknown');
    expect(checks.find((c) => c.id === 'agent-permissions:knowledge-write')?.status).toBe(
      'unknown'
    );
  });

  it('distinguishes explicit Codex MCP prompts from shell approval policy and per-tool approval overrides', () => {
    const root = directory();
    const homeDirectory = directory();
    write(
      path.join(homeDirectory, '.codex', 'config.toml'),
      `approval_policy = "never"
[mcp_servers.contextos]
command = "contextos"
default_tools_approval_mode = "approve" # independent MCP policy
[mcp_servers.contextos.tools.ctx_remember]
approval_mode = "prompt"
`
    );
    const checks = inspectAgentDiagnostics({
      root,
      homeDirectory,
      client: 'codex',
      noninteractive: true
    });
    expect(checks.find((c) => c.id === 'agent-permissions:retrieval')?.status).toBe('pass');
    expect(checks.find((c) => c.id === 'agent-permissions:knowledge-write')?.status).toBe('fail');
    expect(checks.find((c) => c.id === 'agent-permissions:knowledge-write')?.summary).toContain(
      'cannot answer that prompt'
    );
  });

  it('reads inline TOML tool approval tables and JSONC trailing commas safely', () => {
    const root = directory();
    const homeDirectory = directory();
    write(
      path.join(homeDirectory, '.codex', 'config.toml'),
      `[mcp_servers.contextos]
command = 'contextos'
default_tools_approval_mode = "approve"
[mcp_servers.contextos.tools]
ctx_remember = { approval_mode = "prompt" }
`
    );
    expect(
      inspectAgentDiagnostics({ root, homeDirectory, client: 'codex', noninteractive: true }).find(
        (c) => c.id === 'agent-permissions:knowledge-write'
      )?.status
    ).toBe('fail');
    write(
      path.join(root, 'opencode.jsonc'),
      '{"mcp":{"servers":{"contextos":{"command":["contextos","serve",],},},},"permission":{"contextos_*":"allow",},}'
    );
    expect(
      inspectAgentDiagnostics({ root, homeDirectory, client: 'opencode' }).find(
        (c) => c.id === 'agent-permissions:retrieval'
      )?.status
    ).toBe('pass');
  });

  it('respects global configuration directory overrides and OpenCode V2 MCP entries', () => {
    const root = directory();
    const homeDirectory = directory();
    const alternate = directory();
    vi.stubEnv('CODEX_HOME', alternate);
    write(path.join(alternate, 'AGENTS.md'), 'Use get_context');
    write(path.join(alternate, 'config.toml'), '[mcp_servers.contextos]\ncommand = "contextos"\n');
    const codex = inspectAgentDiagnostics({ root, homeDirectory, client: 'codex' });
    expect(codex.find((c) => c.id === 'agent-instructions')?.status).toBe('pass');
    expect(codex.find((c) => c.id === 'agent-mcp-registration')?.status).toBe('pass');
    vi.stubEnv('XDG_CONFIG_HOME', alternate);
    write(path.join(alternate, 'opencode', 'opencode.json'), {
      mcp: { servers: { 'project-context': { command: ['contextos', 'serve'] } } }
    });
    expect(
      inspectAgentDiagnostics({ root, homeDirectory, client: 'opencode' }).find(
        (c) => c.id === 'agent-mcp-registration'
      )?.status
    ).toBe('pass');
  });

  it('reports client-specific registration as unknown when no client is selected', () => {
    const root = directory();
    const homeDirectory = directory();
    const checks = inspectAgentDiagnostics({ root, homeDirectory });
    expect(checks.find((c) => c.id === 'agent-mcp-registration')?.status).toBe('unknown');
    expect(checks.find((c) => c.id === 'agent-permissions:retrieval')?.status).toBe('unknown');
  });

  it('respects Codex tool exclusion and AGENTS.override discovery', () => {
    const root = directory();
    const homeDirectory = directory();
    write(path.join(root, 'AGENTS.md'), 'Use get_context');
    write(path.join(root, 'AGENTS.override.md'), 'Local alternate instructions');
    write(
      path.join(root, '.codex', 'config.toml'),
      '[mcp_servers.contextos-local]\ncommand = "contextos"\ndisabled_tools = ["ctx_remember"]\n'
    );
    const checks = inspectAgentDiagnostics({ root, homeDirectory, client: 'codex' });
    const files = checks.find((c) => c.id === 'agent-instructions')?.details?.files as {
      path: string;
    }[];
    expect(files.some((f) => f.path === path.join(root, 'AGENTS.override.md'))).toBe(true);
    expect(files.some((f) => f.path === path.join(root, 'AGENTS.md'))).toBe(false);
    expect(checks.find((c) => c.id === 'agent-permissions:knowledge-write')?.status).toBe('fail');
  });

  it('reads OpenCode JSONC and ordered tool permission rules without exposing secrets', () => {
    const root = directory();
    const homeDirectory = directory();
    const file = path.join(root, 'opencode.jsonc');
    write(
      file,
      '{\n// client settings\n"mcp":{"contextos":{"type":"local","command":["contextos","serve"],"environment":{"TOKEN":"TOP_SECRET"}}},\n"permission":{"contextos_*":"allow","contextos_ctx_remember":"ask"}\n}'
    );
    const checks = inspectAgentDiagnostics({
      root,
      homeDirectory,
      client: 'opencode',
      noninteractive: true
    });
    expect(checks.find((c) => c.id === 'agent-mcp-registration')?.status).toBe('pass');
    expect(checks.find((c) => c.id === 'agent-permissions:retrieval')?.status).toBe('pass');
    expect(checks.find((c) => c.id === 'agent-permissions:knowledge-write')?.status).toBe('fail');
    expect(JSON.stringify(checks)).not.toContain('TOP_SECRET');
    write(file, '{"TOKEN":"ANOTHER_SECRET", invalid');
    const invalid = inspectAgentDiagnostics({ root, homeDirectory, client: 'opencode' });
    expect(invalid.find((c) => c.id === 'agent-mcp-registration')?.status).toBe('warn');
    expect(JSON.stringify(invalid)).not.toContain('ANOTHER_SECRET');
  });

  it('reports the selected project, worktree, branch and generation without migrating registry', async () => {
    const root = directory();
    const homeDirectory = directory();
    vi.spyOn(os, 'homedir').mockReturnValue(homeDirectory);
    execFileSync('git', ['init', '-b', 'doctor-test', root], { stdio: 'ignore' });
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'Initial'
      ],
      { stdio: 'ignore' }
    );
    const registry = new WorkspaceRegistry();
    const source = registry.register(root);
    registry.close();
    const registryFile = path.join(homeDirectory, '.contextos', 'registry.db');
    const before = fs.readFileSync(registryFile);
    const report = await collectDoctorReport({ cwd: root, homeDirectory, client: 'codex' });
    const scope = report.checks.find((c) => c.id === 'agent-scope');
    expect(scope?.status).toBe('pass');
    expect(scope?.details).toMatchObject({
      projectId: source.projectId,
      worktreeId: source.worktreeId,
      viewId: source.viewId,
      registeredBranch: 'doctor-test',
      currentBranch: 'doctor-test'
    });
    expect(fs.readFileSync(registryFile)).toEqual(before);
    execFileSync('git', ['-C', root, 'switch', '-c', 'changed'], { stdio: 'ignore' });
    const changed = await collectDoctorReport({ cwd: root, homeDirectory });
    expect(changed.checks.find((c) => c.id === 'agent-scope')?.status).toBe('warn');
    expect(fs.existsSync(path.join(root, '.contextos'))).toBe(false);
  });
});
