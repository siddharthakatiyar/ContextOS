import { describe, it, expect } from 'vitest';
import { chunkDocument, splitBlocksRespectingFences } from '../../src/core/chunker/index.js';
import type { ParsedDocument, Section } from '../../src/core/parser/types.js';

function makeSection(title: string, content: string, children: Section[] = []): Section {
  return {
    title,
    depth: 2,
    content,
    startLine: 1,
    endLine: content.split('\n').length,
    children,
    metadata: { hasCodeBlocks: false, hasTables: false, hasLists: false, wordCount: 10 }
  };
}

describe('markdown chunker — fence-aware splitting', () => {
  const fenceBody = [
    '```js',
    'const alpha = computeAlpha();',
    '',
    'const beta = computeBeta(alpha);',
    '',
    'return { alpha, beta };',
    '```'
  ].join('\n');

  // Repeat prose + fenced block until total exceeds a small token budget
  const sectionContent = Array.from({ length: 8 }, (_, i) => {
    return `Paragraph ${i} with several words of filler prose.\n\n${fenceBody}`;
  }).join('\n\n');

  const doc: ParsedDocument = {
    filePath: 'fences.md',
    sections: [makeSection('Root', sectionContent)]
  };

  it('never splits inside a fenced code block when chunking oversized sections', () => {
    const chunks = chunkDocument(doc, { layer: 'repo', maxChunkTokens: 120 });
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks) {
      // Every fence opened in a chunk must also be closed there
      const fences = (chunk.content.match(/```/g) || []).length;
      expect(fences % 2).toBe(0);
    }

    // Every sampled fence block must survive intact somewhere (fences never split)
    const intact = chunks.filter(
      (c) => c.content.includes('const alpha') && c.content.includes('return { alpha, beta };')
    );
    expect(intact.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps blank lines inside fences attached to their block', () => {
    const blocks = splitBlocksRespectingFences(`before

\`\`\`text
line one

line two
\`\`\`

after`);
    // The fenced block with its internal blank line must be ONE block
    const fenced = blocks.find((b) => b.includes('line one'));
    expect(fenced).toBeDefined();
    expect(fenced).toContain('\n\n');
    expect(fenced!.startsWith('```')).toBe(true);
    expect(blocks.filter((b) => b === 'before' || b === 'after')).toHaveLength(2);
  });

  it('hard-splits a single oversized paragraph instead of emitting one giant chunk', () => {
    const giantParagraph = Array.from(
      { length: 60 },
      (_, i) => `Sentence number ${i} adds meaningful tokens to this single paragraph.`
    ).join(' ');

    const chunks = chunkDocument(
      { filePath: 'giant.md', sections: [makeSection('Big', giantParagraph)] },
      { layer: 'repo', maxChunkTokens: 80 }
    );

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.tokenCount).toBeLessThanOrEqual(200); // generous ceiling vs hard-split pieces
    }
  });
});

describe('markdown chunker — duplicate title disambiguation', () => {
  it('assigns distinct stable IDs to sibling sections with identical titles', () => {
    const doc: ParsedDocument = {
      filePath: 'dupes.md',
      sections: [
        makeSection('Root', '', [
          makeSection('Installation', 'First install guide body.'),
          makeSection('Installation', 'Second install guide body.')
        ])
      ]
    };

    const chunks = chunkDocument(doc, { layer: 'repo' });
    const ids = new Set(chunks.map((c) => c.id));
    expect(chunks.length).toBe(2);
    expect(ids.size).toBe(2);

    const titles = chunks.map((c) => c.sectionTitle).sort();
    expect(titles[0]).toBe('Root > Installation');
    expect(titles[1]).toMatch(/^Root > Installation#dup\d+$/);
  });
});
