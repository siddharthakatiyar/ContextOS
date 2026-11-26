import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerWorkspaceTools } from './workspace-tools.js';
import type { WorkspaceRuntime } from '../core/workspace/runtime.js';

/** Run the real registrations, without a repository or any handler execution. */
export async function workspaceToolCatalog(legacyTools = false) {
  const unavailable = () => {
    throw new Error('Catalog generation must not access storage');
  };
  const source = { rootPath: '/', repoId: 'catalog' };
  const runtime = {
    registry: { active: () => source },
    select: () => ({ sources: [source] }),
    get: () => ({
      config: { legacyTools },
      db: { getInstance: () => new Proxy({}, { get: unavailable }) }
    })
  } as unknown as WorkspaceRuntime;
  const server = new McpServer({ name: 'contextos', version: 'catalog' });
  registerWorkspaceTools(server, runtime, { cwd: '/' });
  const client = new Client({ name: 'catalog', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(a);
    await client.connect(b);
    return await client.listTools();
  } finally {
    await client.close();
    await server.close();
  }
}
