import { describe, it, expect } from 'vitest';
import { parseMarkdown } from '../../src/core/parser/markdown-parser.js';

describe('markdown-parser', () => {
  it('should extract sections based on headers', () => {
    const md = `
# Title
Intro

## Subtitle
Details

### Deep
More details
    `;
    const doc = parseMarkdown('test.md', md);
    expect(doc.sections.length).toBeGreaterThan(0);
    expect(doc.sections[0].title).toBe('Title');
    expect(doc.sections[0].children[0].title).toBe('Subtitle');
    expect(doc.sections[0].children[0].children[0].title).toBe('Deep');
  });

  it('should extract metadata from sections', () => {
    const md = `
## Code Section
\`\`\`js
const x = 1;
\`\`\`
    `;
    const doc = parseMarkdown('test.md', md);
    expect(doc.sections[0].metadata.hasCodeBlocks).toBe(true);
  });
});
