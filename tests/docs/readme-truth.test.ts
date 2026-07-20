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

  it('documents all configuration keys', () => {
    const configKeys = Object.keys(defaultConfig);
    const configSectionMatch = readme.match(/## Configuration\n\n```json\n([\s\S]*?)\n```/);
    expect(configSectionMatch).toBeDefined();

    if (configSectionMatch) {
      const documentedConfig = configSectionMatch[1];
      for (const key of configKeys) {
        expect(documentedConfig).toContain(`"${key}"`);
      }
    }
  });

  it('does not contain phantom headers', () => {
    // Check that we don't have broken markdown headers or C1/C2 leftover placeholders
    expect(readme).not.toContain('C1');
    expect(readme).not.toContain('C2');
  });

  it('documents MCP tools correctly', () => {
    const tools = [
      'get_context',
      'ctx_execute',
      'reindex_context',
      'ctx_list_topics',
      'ctx_read_topic',
      'learn_fact',
      'forget_fact'
    ];

    const toolsSectionMatch = readme.match(/## Available Tools\n\n([\s\S]*?)(?=\n## |$)/);
    expect(toolsSectionMatch).toBeDefined();

    if (toolsSectionMatch) {
      const section = toolsSectionMatch[1];
      for (const tool of tools) {
        expect(section).toContain(`\`${tool}\``);
      }
    }
  });
});
