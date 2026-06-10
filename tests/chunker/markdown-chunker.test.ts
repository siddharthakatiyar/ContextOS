import { describe, it, expect } from 'vitest';
import { chunkDocument } from '../../src/core/chunker/index.js';

describe('markdown-chunker', () => {
  it('should chunk markdown sections properly', () => {
    const doc = {
      filePath: 'README.md',
      sections: [
        {
          title: 'Root',
          depth: 1,
          content: 'Intro',
          startLine: 1,
          endLine: 2,
          children: [],
          metadata: { hasCodeBlocks: false, hasTables: false, hasLists: false, wordCount: 1 }
        }
      ]
    };

    const chunks = chunkDocument(doc, { layer: 'repo' });
    expect(chunks.length).toBe(1);
    expect(chunks[0].sectionTitle).toBe('Root');
    expect(chunks[0].content).toBe('Intro');
  });
});
