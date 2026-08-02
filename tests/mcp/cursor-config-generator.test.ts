import { afterEach, describe, expect, it } from 'vitest';
import {
  generateCursorConfig,
  generateCursorConfigGlobal
} from '../../src/mcp/cursor/config-generator.js';

describe('generateCursorConfig', () => {
  const originalCommand = process.env.CONTEXTOS_MCP_COMMAND;
  const originalArgs = process.env.CONTEXTOS_MCP_ARGS;

  afterEach(() => {
    if (originalCommand === undefined) delete process.env.CONTEXTOS_MCP_COMMAND;
    else process.env.CONTEXTOS_MCP_COMMAND = originalCommand;

    if (originalArgs === undefined) delete process.env.CONTEXTOS_MCP_ARGS;
    else process.env.CONTEXTOS_MCP_ARGS = originalArgs;
  });

  it('uses portable contextos serve defaults', () => {
    delete process.env.CONTEXTOS_MCP_COMMAND;
    delete process.env.CONTEXTOS_MCP_ARGS;

    expect(generateCursorConfig({ projectRoot: '/repo' })).toEqual({
      mcpServers: {
        contextos: {
          command: 'contextos',
          args: ['serve'],
          env: {
            CONTEXTOS_REPO_ROOT: '/repo',
            CONTEXTOS_WORKSPACE: ''
          }
        }
      }
    });
  });

  it('preserves environment settings for local config', () => {
    const config = generateCursorConfig({ projectRoot: '/repo', workspaceName: 'workspace-a' });

    expect(config.mcpServers.contextos.env).toEqual({
      CONTEXTOS_REPO_ROOT: '/repo',
      CONTEXTOS_WORKSPACE: 'workspace-a'
    });
  });

  it('allows overriding command and args from environment variables', () => {
    process.env.CONTEXTOS_MCP_COMMAND = 'node';
    process.env.CONTEXTOS_MCP_ARGS = 'dist/bin/contextos.js serve';

    const config = generateCursorConfig({ projectRoot: '/repo' });

    expect(config.mcpServers.contextos.command).toBe('node');
    expect(config.mcpServers.contextos.args).toEqual(['dist/bin/contextos.js', 'serve']);
  });
});

describe('generateCursorConfigGlobal', () => {
  it('keeps global config command and args unchanged', () => {
    expect(generateCursorConfigGlobal()).toEqual({
      mcpServers: {
        contextos: {
          command: 'contextos',
          args: ['serve']
        }
      }
    });
  });
});
