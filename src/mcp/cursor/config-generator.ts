export interface CursorMcpConfig {
  mcpServers: {
    [key: string]: {
      command: string;
      args: string[];
      env?: Record<string, string>;
    };
  };
}

export function generateCursorConfig(options: {
  projectRoot: string;
  workspaceName?: string;
}): CursorMcpConfig {
  const command = process.env.CONTEXTOS_MCP_COMMAND || 'contextos';
  const args = process.env.CONTEXTOS_MCP_ARGS
    ? process.env.CONTEXTOS_MCP_ARGS.split(' ').filter(Boolean)
    : ['serve'];

  return {
    mcpServers: {
      contextos: {
        command,
        args,
        env: {
          CONTEXTOS_REPO_ROOT: options.projectRoot,
          CONTEXTOS_WORKSPACE: options.workspaceName ?? ''
        }
      }
    }
  };
}

export function generateCursorConfigGlobal(): CursorMcpConfig {
  return {
    mcpServers: {
      contextos: {
        command: 'contextos',
        args: ['serve']
      }
    }
  };
}
