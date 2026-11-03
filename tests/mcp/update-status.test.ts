import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerUpdateStatusTool } from '../../src/mcp/tools/update-status.js';
import { getPackageVersion } from '../../src/utils/version.js';

function nextPatchVersion(version: string): string {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) throw new Error(`Expected a stable package version, received ${version}.`);
  return `${match[1]}.${match[2]}.${BigInt(match[3]!) + 1n}`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('contextos_update_status MCP tool', () => {
  it('publishes a structured, read-only update result for the installed version', async () => {
    const currentVersion = getPackageVersion();
    const latestVersion = nextPatchVersion(currentVersion);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ version: latestVersion }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      )
    );

    let registration:
      | {
          name: string;
          config: { description?: string; outputSchema?: unknown };
          handler: () => Promise<{
            structuredContent?: Record<string, unknown>;
            content: Array<{ text?: string }>;
          }>;
        }
      | undefined;
    const server = {
      registerTool: (
        name: string,
        config: { description?: string; outputSchema?: unknown },
        handler: () => Promise<{
          structuredContent?: Record<string, unknown>;
          content: Array<{ text?: string }>;
        }>
      ) => {
        registration = { name, config, handler };
      }
    };

    registerUpdateStatusTool(server as never);
    expect(registration?.name).toBe('contextos_update_status');
    expect(registration?.config.description).toContain('never installs');
    expect(registration?.config.outputSchema).toBeDefined();

    const result = await registration!.handler();
    expect(result.structuredContent).toMatchObject({
      status: 'update_available',
      currentVersion,
      latestVersion,
      updateAvailable: true,
      compatible: true,
      upgradeCommand: 'contextos upgrade'
    });
    expect(result.content[0]?.text).toContain('contextos upgrade');
  });

  it('does not claim a registry result when offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      })
    );

    let handler:
      | (() => Promise<{
          structuredContent?: Record<string, unknown>;
          content: Array<{ text?: string }>;
        }>)
      | undefined;
    const server = {
      registerTool: (_name: string, _config: unknown, callback: typeof handler) => {
        handler = callback as typeof handler;
      }
    };

    registerUpdateStatusTool(server as never);
    const result = await handler!();

    expect(result.structuredContent).toMatchObject({
      status: 'unknown',
      latestVersion: null,
      updateAvailable: null,
      compatible: null
    });
    expect(result.content[0]?.text).toContain('unknown');
  });
});
