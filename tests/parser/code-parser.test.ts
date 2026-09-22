import { describe, it, expect } from 'vitest';
import { detectLanguage, parseCode } from '../../src/core/parser/code-parser.js';
import { chunkCode } from '../../src/core/chunker/code-chunker.js';

describe('code-parser', () => {
  it('should detect language from extension', () => {
    expect(detectLanguage('index.ts')).toBe('typescript');
    expect(detectLanguage('main.py')).toBe('python');
    expect(detectLanguage('unknown.xyz')).toBe('unknown');
  });

  it('should parse functions using tree-sitter', async () => {
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

  it('should parse classes using tree-sitter', async () => {
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

  it('extracts Rust use paths for graph imports', async () => {
    const doc = await parseCode('lib.rs', 'use crate::foo::Bar;\n\npub fn run() {}');

    expect(doc.imports).toContain('crate::foo::Bar');
    expect(doc.symbols.some((symbol) => symbol.kind === 'import')).toBe(true);
  });

  it('does not lose a one-line parsed Rust function during chunking', async () => {
    const doc = await parseCode('small.rs', 'pub fn temp_func() { return_value(); }');
    const chunks = chunkCode(doc, { layer: 'repo' });

    expect(chunks.some((chunk) => chunk.symbolName === 'temp_func')).toBe(true);
  });
});
