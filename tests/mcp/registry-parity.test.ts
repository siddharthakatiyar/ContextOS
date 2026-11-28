import fs from 'node:fs';
import crypto from 'node:crypto';
import { expect, it } from 'vitest';
import { workspaceToolCatalog } from '../../src/mcp/tool-catalog.js';
import { workspaceToolRegistry } from '../../src/mcp/tool-registry.js';
import { loadCommands } from '../../src/cli/command-registry.js';

// Captured from unmodified main/1.2.5 registrations. Hash the serialized full tool
// definitions as well as comparing ordered names, allowing only new optional write params.
const baseline = JSON.parse(
  fs.readFileSync(new URL('../fixtures/tool-catalog-125.json', import.meta.url), 'utf8')
);
it.each([false, true])(
  'preserves ordered tool names and catalog bytes (legacy=%s)',
  async (legacy) => {
    const catalog = await workspaceToolCatalog(legacy);
    const tools = JSON.parse(JSON.stringify(catalog.tools)) as typeof catalog.tools;
    for (const tool of tools) {
      if (tool.name === 'ctx_links') delete tool.inputSchema.properties?.include_stale;
      if (['ctx_remember', 'ctx_link', 'learn_fact'].includes(tool.name)) {
        for (const field of ['author', 'task_id', 'model', 'status', 'namespace', 'expires_at'])
          delete tool.inputSchema.properties?.[field];
      }
    }
    expect(
      tools.map((tool) => ({
        name: tool.name,
        sha256: crypto.createHash('sha256').update(JSON.stringify(tool)).digest('hex')
      }))
    ).toEqual(baseline[legacy ? 'legacy' : 'standard']);
    expect(new Set(workspaceToolRegistry.map((entry) => entry.name)).size).toBe(
      workspaceToolRegistry.length
    );
    expect(
      tools.every((tool) => workspaceToolRegistry.some((entry) => entry.name === tool.name))
    ).toBe(true);
  }
);
it('loads the existing CLI commands in their original order', async () => {
  expect((await loadCommands()).map((command) => command.name())).toEqual([
    'init',
    'setup',
    'enable',
    'serve',
    'query',
    'workspace',
    'watch',
    'export',
    'import',
    'analytics',
    'status',
    'verify',
    'doctor',
    'reindex',
    'clean',
    'daemon',
    'visualize',
    'upgrade',
    'updates',
    'project',
    'group',
    'worktree'
  ]);
});
