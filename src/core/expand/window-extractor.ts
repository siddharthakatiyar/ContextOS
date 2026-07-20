import fs from 'node:fs';
import { estimateTokens } from '../../utils/tokens.js';

export interface WindowOptions {
  maxTokens?: number;
  linesBefore?: number;
  linesAfter?: number;
}

export function extractTermWindows(
  filePath: string,
  terms: string[],
  opts: WindowOptions = {}
): string {
  if (!fs.existsSync(filePath)) {
    return `File not found: ${filePath}`;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const maxTokens = opts.maxTokens ?? 2000;
  const before = opts.linesBefore ?? 5;
  const after = opts.linesAfter ?? 5;

  const matchLines: number[] = [];
  const lowerTerms = terms.map((t) => t.toLowerCase());

  for (let i = 0; i < lines.length; i++) {
    const lineLower = lines[i].toLowerCase();
    for (const term of lowerTerms) {
      if (lineLower.includes(term)) {
        matchLines.push(i);
        break;
      }
    }
  }

  if (matchLines.length === 0) {
    return `No matches found for terms [${terms.join(', ')}] in ${filePath}`;
  }

  // Merge overlapping windows
  const windows: Array<{ start: number; end: number }> = [];
  for (const lineIdx of matchLines) {
    const start = Math.max(0, lineIdx - before);
    const end = Math.min(lines.length - 1, lineIdx + after);

    if (windows.length > 0) {
      const last = windows[windows.length - 1];
      if (start <= last.end + 1) {
        last.end = Math.max(last.end, end);
        continue;
      }
    }
    windows.push({ start, end });
  }

  let out = '';
  for (let i = 0; i < windows.length; i++) {
    const w = windows[i];
    if (i > 0 && w.start > windows[i - 1].end + 1) {
      out += `\n// ...\n\n`;
    }
    for (let j = w.start; j <= w.end; j++) {
      out += `${lines[j]}\n`;
    }
    if (estimateTokens(out) > maxTokens) {
      out += `\n// [Truncated] Output exceeded ${maxTokens} tokens.\n`;
      break;
    }
  }

  return out.trim();
}
