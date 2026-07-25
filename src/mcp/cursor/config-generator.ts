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
  return {
    mcpServers: {
      contextos: {
        command: 'node',
        args: ['/Volumes/ExtremeSSD/code/contextOS/dist/bin/contextos.js', 'serve'],
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
