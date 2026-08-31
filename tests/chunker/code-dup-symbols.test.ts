import { describe, it, expect } from 'vitest';
import { parseCode } from '../../src/core/parser/index.js';
import { chunkCode } from '../../src/core/chunker/code-chunker.js';

describe('code chunker — duplicate symbol disambiguation', () => {
  it('assigns distinct stable IDs to same-named symbols (e.g. overloads)', async () => {
    const source = [
      'export function probe(x: string): string {',
      '  const normalized = x.trim();',
      '  return normalized.toLowerCase();',
      '}',
      '',
      'export function probe(x: number): number {',
      '  const scaled = x * 2;',
      '  return Math.round(scaled);',
      '}'
    ].join('\n');

    const parsed = await parseCode('overloads.ts', source);
    const chunks = chunkCode(parsed, { layer: 'repo' });

    const probeChunks = chunks.filter((c) => c.symbolName === 'probe');
    expect(probeChunks.length).toBe(2);

    const ids = new Set(probeChunks.map((c) => c.id));
    expect(ids.size).toBe(2);
    expect(probeChunks.map((c) => c.sectionTitle).sort()).toEqual(['probe', 'probe#dup1']);
  });
});
