import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/config/defaults.js';

describe('README.md Truth Pass', () => {
  const root = path.resolve(__dirname, '../../');
  const readmePath = path.join(root, 'README.md');
  const pkgPath = path.join(root, 'package.json');

  const readme = fs.readFileSync(readmePath, 'utf8');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

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

  it('documents core MCP tools', () => {
    // Each core tool must be named (in backticks) somewhere in the README.
    const tools = [
      'get_context',
      'ctx_execute',
      'reindex_context',
      'ctx_read_file',
      'get_symbol',
      'learn_fact',
      'forget_fact'
    ];
    for (const tool of tools) {
      expect(readme, `README should document the \`${tool}\` MCP tool`).toContain(`\`${tool}\``);
    }
  });
});
