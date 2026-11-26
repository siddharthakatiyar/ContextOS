import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { getPackageVersion } from '../utils/version.js';

/** The handshake never imports the registry, opens a view, or starts a daemon. */
export async function runHandshakeProxy(): Promise<void> {
  const catalog = JSON.parse(
    fs.readFileSync(new URL('./tool-catalog.json', import.meta.url), 'utf8')
  ) as {
    instructions: string;
    standard: ListToolsResult;
    legacy: ListToolsResult;
  };
  const server = new Server(
    { name: 'contextos', version: getPackageVersion() },
    { capabilities: { tools: { listChanged: true } }, instructions: catalog.instructions }
  );
  let backend: Promise<Client> | undefined;
  let transport: StdioClientTransport | undefined;
  let closed = false;
  const connect = async () => {
    const client = new Client({ name: 'contextos-proxy', version: getPackageVersion() });
    client.onclose = () => {
      backend = undefined;
    };
    client.fallbackNotificationHandler = (notification) => server.notification(notification);
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../../bin/contextos.js', import.meta.url)),
        ...process.argv.slice(2)
      ],
      env: Object.fromEntries(
        Object.entries({ ...process.env, CONTEXTOS_DAEMON_PROXY_BACKEND: '1' }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
      stderr: 'pipe'
    });
    let diagnostic = '';
    transport.stderr?.on('data', (data: Buffer) => {
      diagnostic = (diagnostic + data.toString('utf8')).slice(-4096);
      process.stderr.write(data);
    });
    try {
      await client.connect(transport, {
        timeout: Number(process.env.CONTEXTOS_DAEMON_CONNECT_TIMEOUT_MS) || 30_000
      });
      if (closed) {
        await client.close();
        throw new Error('Client closed');
      }
      return client;
    } catch (error) {
      await transport.close();
      backend = undefined;
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}${diagnostic.trim() ? `: ${diagnostic.trim()}` : ''}`
      );
    }
  };
  // Unknown methods, including server/discover, receive the SDK's -32601 reply.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { loadConfig } = await import('../config/index.js');
    let cwd = process.env.CONTEXTOS_REPO_ROOT || process.cwd();
    const args = process.argv.slice(2);
    const selector = ['--worktree', '--project', '--repo']
      .map((flag) => {
        const index = args.indexOf(flag);
        return index >= 0
          ? args[index + 1]
          : args.find((arg) => arg.startsWith(flag + '='))?.slice(flag.length + 1);
      })
      .find(Boolean);
    if (selector) {
      const { WorkspaceRegistry } = await import('../core/workspace/registry.js');
      const registry = new WorkspaceRegistry();
      try {
        cwd = registry.resolve(selector).rootPath;
      } finally {
        registry.close();
      }
    }
    return loadConfig({ cwd }).legacyTools ? catalog.legacy : catalog.standard;
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const client = await (backend ??= connect());
      return await client.callTool(request.params, undefined, {
        signal: extra.signal,
        timeout: 120_000
      });
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `ContextOS daemon unavailable: ${error instanceof Error ? error.message : String(error)}. Run contextos daemon status to diagnose; retry the tool call.`
          }
        ]
      };
    }
  });
  server.onclose = () => {
    closed = true;
    void transport?.close();
  };
  process.stdin.once('end', () => void server.close());
  await server.connect(new StdioServerTransport());
}
