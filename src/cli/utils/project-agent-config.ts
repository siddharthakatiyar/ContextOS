import fs from 'node:fs';
import path from 'node:path';
import type { CursorMcpConfig } from '../../mcp/cursor/config-generator.js';
import { enableGlobalAgentInstructions } from './global-agent-setup.js';

/** JSON configurations are planned before project registration so invalid files fail safely. */
export function projectAgentJsonPaths(root: string): string[] {
  const detected = new Set(
    enableGlobalAgentInstructions({ dryRun: true })
      .filter((result) => result.status !== 'not-installed')
      .map((result) => result.agent)
  );
  return [
    ...(detected.has('antigravity') || fs.existsSync(path.join(root, '.agents'))
      ? [path.join(root, '.agents', 'mcp_config.json')]
      : []),
    ...(detected.has('gemini') ? [path.join(root, '.gemini', 'settings.json')] : [])
  ];
}

/** Add project-scoped registrations for detected clients while preserving existing entries. */
function existsWithoutSymlink(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Cannot update symlink ${file}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function installProjectAgentConfigs(
  root: string,
  generated: CursorMcpConfig
): { written: string[]; warnings: string[] } {
  const detected = new Set(
    enableGlobalAgentInstructions({ dryRun: true })
      .filter((r) => r.status !== 'not-installed')
      .map((r) => r.agent)
  );
  const server = generated.mcpServers.contextos;
  const written: string[] = [];
  const warnings: string[] = [];
  for (const client of ['codex', 'grok'] as const) {
    const file = path.join(root, `.${client}`, 'config.toml');
    const dirExists = existsWithoutSymlink(path.dirname(file));
    if (!detected.has(client) && !dirExists) continue;
    const old = existsWithoutSymlink(file) ? fs.readFileSync(file, 'utf8') : '';
    // Preserve any explicit server configuration, including quoted TOML table keys.
    if (
      /^\s*\[\s*mcp_servers\s*\.\s*(?:contextos|"contextos"|'contextos')(?:\s*\.|\s*\])/m.test(
        old
      ) ||
      /^\s*mcp_servers\s*=\s*\{/m.test(old)
    )
      continue;
    const env = Object.entries(server.env ?? {})
      .map(([key, value]) => `${key} = ${JSON.stringify(value)}`)
      .join('\n');
    const stanza = `[mcp_servers.contextos]\ncommand = ${JSON.stringify(server.command)}\nargs = ${JSON.stringify(server.args)}\n\n[mcp_servers.contextos.env]\n${env}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${old}${old && !old.endsWith('\n') ? '\n' : ''}${old ? '\n' : ''}${stanza}`,
      { mode: 0o600 }
    );
    written.push(file);
  }
  const file = path.join(root, 'opencode.json');
  const fileExists = existsWithoutSymlink(file);
  const jsonc = path.join(root, 'opencode.jsonc');
  const jsoncExists = existsWithoutSymlink(jsonc);
  if (detected.has('opencode') || fileExists || jsoncExists) {
    // JSONC may contain comments; never rewrite it or shadow its registration.
    if (jsoncExists) {
      warnings.push(
        `OpenCode configuration ${jsonc} was preserved; add the ContextOS MCP server there manually if needed.`
      );
      return { written, warnings };
    }
    const config = fileExists
      ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)
      : {};
    if (!config || typeof config !== 'object' || Array.isArray(config))
      throw new Error(`Invalid OpenCode configuration: ${file}`);
    const mcp = config.mcp ?? {};
    if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp))
      throw new Error(`Invalid OpenCode MCP configuration: ${file}`);
    const m = mcp as Record<string, unknown>;
    const servers = m.servers ?? {};
    if (!servers || typeof servers !== 'object' || Array.isArray(servers))
      throw new Error(`Invalid OpenCode MCP servers: ${file}`);
    const entries = servers as Record<string, unknown>;
    if (!Object.hasOwn(entries, 'contextos') && !Object.hasOwn(m, 'contextos')) {
      config.mcp = {
        ...m,
        servers: {
          ...entries,
          contextos: {
            type: 'local',
            command: [server.command, ...server.args],
            environment: server.env
          }
        }
      };
      fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      written.push(file);
    }
  }
  return { written, warnings };
}
