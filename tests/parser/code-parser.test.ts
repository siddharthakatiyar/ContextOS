import { describe, it, expect } from 'vitest';
import { detectLanguage, parseCode } from '../../src/core/parser/code-parser.js';

describe('code-parser', () => {
  it('should detect language from extension', () => {
    expect(detectLanguage('index.ts')).toBe('typescript');
    expect(detectLanguage('main.py')).toBe('python');
    expect(detectLanguage('unknown.xyz')).toBe('unknown');
  });

  it.skip('should parse functions using tree-sitter', async () => {
    const code = `
      function add(a: number, b: number): number {
        return a + b;
      }
    `;
    const doc = await parseCode('math.ts', code);
    expect(doc.language).toBe('typescript');
    expect(doc.symbols.length).toBeGreaterThan(0);
    expect(doc.symbols[0].name).toBe('add');
    expect(doc.symbols[0].kind).toBe('function');
    expect(doc.symbols[0].body).toContain('return a + b');
  });

  it.skip('should parse classes using tree-sitter', async () => {
    const code = `
      class Calculator {
        multiply(a, b) {
          return a * b;
        }
      }
    `;
    const doc = await parseCode('calc.js', code);
    const clazz = doc.symbols.find((s) => s.kind === 'class');
    expect(clazz).toBeDefined();
    expect(clazz?.name).toBe('Calculator');
  });
});
