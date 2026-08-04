import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/config/defaults.js';

describe('README.md Truth Pass', () => {
  const root = path.resolve(__dirname, '../../');
  const readmePath = path.join(root, 'README.md');
  const readme = fs.readFileSync(readmePath, 'utf8');

  it('documents current config defaults accurately', () => {
    // Guard against README Configuration-table drift from src/config/defaults.ts.
    // Each entry must appear in the table as: | `key` | `value` | ...
    const checks: Array<[string, number]> = [
      ['maxTokenBudget', defaultConfig.maxTokenBudget],
      ['maxRetrievalResults', defaultConfig.maxRetrievalResults],
      ['ftsLimit', defaultConfig.ftsLimit],
      ['maxChunkTokens', defaultConfig.maxChunkTokens],
      ['maxSymbolChunkTokens', defaultConfig.maxSymbolChunkTokens],
      ['graphExpansionDepth', defaultConfig.graphExpansionDepth],
      ['graphExpansionMaxNodes', defaultConfig.graphExpansionMaxNodes]
    ];
    for (const [key, value] of checks) {
      const rowRe = new RegExp(`\\|\\s*\`${key}\`\\s*\\|\\s*\`${value}\``);
      expect(readme, `README config table default for ${key} should be ${value}`).toMatch(rowRe);
    }
  });

  it('does not contain phantom headers', () => {
    // Check that we don't have broken markdown headers or C1/C2 leftover placeholders
    expect(readme).not.toContain('C1');
    expect(readme).not.toContain('C2');
  });

  it('documents the default stable and legacy MCP tool surfaces', () => {
    const tools = [
      'get_context',
      'reindex_context',
      'contextos_status',
      'ctx_execute',
      'ctx_read_file',
      'ctx_expand',
      'ctx_topics',
      'ctx_remember',
      'learn_fact',
      'forget_fact',
      'rate_chunk',
      'ctx_symbol',
      'get_neighbors',
      'get_symbol'
    ];
    for (const tool of tools) {
      expect(readme, `README should document the \`${tool}\` MCP tool`).toContain(`\`${tool}\``);
    }
    for (const legacyTool of ['save_context', 'ctx_list_topics', 'ctx_read_topic']) {
      expect(readme).toContain(`\`${legacyTool}\``);
    }
    expect(readme).toContain('Deprecated compatibility tools');
  });
});
