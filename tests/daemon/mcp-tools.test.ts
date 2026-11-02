import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ContextOSDaemon } from '../../src/core/daemon/daemon.js';
import { DB } from '../../src/core/storage/database.js';

interface ProtocolResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { message: string };
}

function installResponseReader(socket: PassThrough) {
  const pending = new Map<number, (response: ProtocolResponse) => void>();
  let buffer = '';

  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');

      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        message !== null &&
        typeof message === 'object' &&
        'id' in message &&
        typeof message.id === 'number' &&
        ('result' in message || 'error' in message)
      ) {
        pending.get(message.id)?.(message as ProtocolResponse);
      }
    }
  });

  return {
    request(id: number, method: string, params: Record<string, unknown>) {
      return new Promise<ProtocolResponse>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timed out waiting for MCP ${method} response`));
        }, 5_000);
        pending.set(id, (response) => {
          clearTimeout(timeout);
          pending.delete(id);
          resolve(response);
        });
        socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method: string, params: Record<string, unknown>) {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    }
  };
}

describe('daemon MCP tool protocol', () => {
  let daemon: ContextOSDaemon | undefined;
  let db: DB | undefined;
  let tempRoot: string | undefined;
  let originalRepoRoot: string | undefined;

  afterEach(async () => {
    if (daemon) {
      await daemon.stop();
      daemon = undefined;
      db = undefined;
    } else {
      db?.close();
      db = undefined;
    }

    if (originalRepoRoot === undefined) {
      delete process.env.CONTEXTOS_REPO_ROOT;
    } else {
      process.env.CONTEXTOS_REPO_ROOT = originalRepoRoot;
    }
    originalRepoRoot = undefined;

    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it('advertises and executes ctx_read_file and ctx_expand over MCP', async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'contextos-daemon-mcp-'));
    const projectDir = path.join(tempRoot, 'project');
    fs.mkdirSync(projectDir);
    fs.writeFileSync(
      path.join(projectDir, 'helper.ts'),
      'export function helper() {\n  const targetNeedle = 42;\n  return targetNeedle;\n}\n'
    );

    originalRepoRoot = process.env.CONTEXTOS_REPO_ROOT;
    process.env.CONTEXTOS_REPO_ROOT = projectDir;

    db = new DB(path.join(projectDir, '.contextos', 'index.db'));
    daemon = new ContextOSDaemon(projectDir);
    const socket = new PassThrough();
    const internalDaemon = daemon as unknown as {
      dbs: DB[];
      handleConnection(socket: PassThrough): void;
    };
    internalDaemon.dbs = [db];
    const protocol = installResponseReader(socket);
    internalDaemon.handleConnection(socket);

    const initialized = await protocol.request(1, 'initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'daemon-protocol-test', version: '1.0.0' }
    });
    expect(initialized.error).toBeUndefined();
    protocol.notify('notifications/initialized', {});

    const listed = await protocol.request(2, 'tools/list', {});
    const tools = listed.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toContain('ctx_read_file');
    expect(tools.map((tool) => tool.name)).toContain('ctx_expand');

    const read = await protocol.request(3, 'tools/call', {
      name: 'ctx_read_file',
      arguments: { filePath: 'helper.ts', start_line: 2, end_line: 3 }
    });
    const readResult = read.result as { content?: Array<{ text?: string }>; isError?: boolean };
    expect(readResult.isError).not.toBe(true);
    expect(readResult.content?.[0]?.text).toContain('targetNeedle = 42');
    expect(readResult.content?.[0]?.text).toContain('return targetNeedle');

    const expanded = await protocol.request(4, 'tools/call', {
      name: 'ctx_expand',
      arguments: {
        paths: ['helper.ts'],
        terms: ['targetNeedle'],
        linesBefore: 0,
        linesAfter: 0
      }
    });
    const expandResult = expanded.result as {
      content?: Array<{ text?: string }>;
      isError?: boolean;
    };
    expect(expandResult.isError).not.toBe(true);
    expect(expandResult.content?.[0]?.text).toContain('targetNeedle');
  });
});
