import { describe, it, expect } from 'vitest';
import { parseConfig } from '../../src/core/parser/config-parser.js';

describe('config-parser', () => {
  it('should parse JSON keys', () => {
    const json = `{
  "name": "contextos",
  "version": "1.0.0"
}`;
    const doc = parseConfig('package.json', json);
    expect(doc.symbols.length).toBe(2);
    expect(doc.symbols[0].name).toBe('name');
    expect(doc.symbols[1].name).toBe('version');
  });

  it('should parse YAML keys', () => {
    const yaml = `
app:
  name: test
port: 8080
`;
    const doc = parseConfig('config.yml', yaml);
    expect(doc.symbols.some(s => s.name === 'app')).toBe(true);
    expect(doc.symbols.some(s => s.name === 'port')).toBe(true);
  });
});
