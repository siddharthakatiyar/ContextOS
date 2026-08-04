import fs from 'node:fs';
import path from 'node:path';
import type { CursorMcpConfig } from '../../mcp/cursor/config-generator.js';

type JsonObject = Record<string, unknown>;

export function readJsonObject(configPath: string): JsonObject {
  if (!fs.existsSync(configPath)) return {};
  const raw = fs.readFileSync(configPath, 'utf8').trim();
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot update invalid JSON config ${configPath}: ${detail}`);
  }
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error(`Cannot update MCP config ${configPath}: top-level value must be an object`);
  }
  const config = value as JsonObject;
  if (
    config.mcpServers !== undefined &&
    (config.mcpServers === null ||
      Array.isArray(config.mcpServers) ||
      typeof config.mcpServers !== 'object')
  ) {
    throw new Error(`Cannot update MCP config ${configPath}: mcpServers must be an object`);
  }
  return config;
}

export function validateJsonConfigs(configPaths: string[]): void {
  for (const configPath of configPaths) readJsonObject(configPath);
}

function writeJsonAtomic(configPath: string, value: JsonObject): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.contextos-${process.pid}-${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    fs.renameSync(temporaryPath, configPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

/** Add ContextOS only when the user has not already configured it. */
export function mergeContextosMcpConfig(
  configPath: string,
  generated: CursorMcpConfig
): 'created' | 'preserved' {
  const config = readJsonObject(configPath);
  const currentServers = config.mcpServers;
  const mcpServers =
    currentServers !== null && !Array.isArray(currentServers) && typeof currentServers === 'object'
      ? (currentServers as JsonObject)
      : {};

  if (Object.prototype.hasOwnProperty.call(mcpServers, 'contextos')) return 'preserved';

  writeJsonAtomic(configPath, {
    ...config,
    mcpServers: {
      ...mcpServers,
      ...generated.mcpServers
    }
  });
  return 'created';
}
