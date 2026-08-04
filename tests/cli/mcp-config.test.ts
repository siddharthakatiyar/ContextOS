import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeContextosMcpConfig, validateJsonConfigs } from '../../src/cli/utils/mcp-config.js';

const generated = {
  mcpServers: {
    contextos: { command: 'contextos', args: ['serve'] }
  }
};

const temporaryDirectories: string[] = [];
function temporaryFile(name = 'mcp.json'): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-mcp-config-'));
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('MCP config merging', () => {
  it('creates a missing config and retains unrelated servers', () => {
    const configPath = temporaryFile();
    fs.writeFileSync(configPath, JSON.stringify({ mcpServers: { other: { command: 'other' } } }));

    expect(mergeContextosMcpConfig(configPath, generated)).toBe('created');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(config.mcpServers.other.command).toBe('other');
    expect(config.mcpServers.contextos.command).toBe('contextos');
  });

  it('preserves an existing ContextOS entry byte-for-byte', () => {
    const configPath = temporaryFile();
    const original = '{"mcpServers":{"contextos":{"command":"custom"}}}\n';
    fs.writeFileSync(configPath, original);

    expect(mergeContextosMcpConfig(configPath, generated)).toBe('preserved');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
  });

  it('is idempotent', () => {
    const configPath = temporaryFile();
    mergeContextosMcpConfig(configPath, generated);
    const first = fs.readFileSync(configPath, 'utf8');
    expect(mergeContextosMcpConfig(configPath, generated)).toBe('preserved');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(first);
  });

  it('rejects malformed JSON without changing it', () => {
    const configPath = temporaryFile();
    fs.writeFileSync(configPath, '{broken');
    expect(() => validateJsonConfigs([configPath])).toThrow(`invalid JSON config ${configPath}`);
    expect(fs.readFileSync(configPath, 'utf8')).toBe('{broken');
  });

  it('rejects an invalid mcpServers shape without changing it', () => {
    const configPath = temporaryFile();
    const original = JSON.stringify({ mcpServers: 'not-an-object' });
    fs.writeFileSync(configPath, original);
    expect(() => validateJsonConfigs([configPath])).toThrow('mcpServers must be an object');
    expect(fs.readFileSync(configPath, 'utf8')).toBe(original);
  });
});
