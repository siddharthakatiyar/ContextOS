import { parseMarkdown } from './markdown-parser.js';
import { ParsedDocument } from './types.js';

export function parseText(filePath: string, content: string): ParsedDocument {
  // For text files, we fallback to treating it as a markdown file with no headings
  return parseMarkdown(filePath, content);
}
