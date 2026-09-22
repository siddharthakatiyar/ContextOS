import fs from 'node:fs';
import { estimateTokens } from '../../utils/tokens.js';

export interface WindowOptions {
  maxTokens?: number;
  linesBefore?: number;
  linesAfter?: number;
}

export const MAX_EXPAND_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_EXPAND_FILE_TOKENS = 2_000;
export const MAX_EXPAND_RESPONSE_TOKENS = 8_000;
export const MAX_EXPAND_PATHS = 32;
export const MAX_EXPAND_TERMS = 64;
export const MAX_EXPAND_TERM_LENGTH = 256;
export const MAX_EXPAND_WINDOW_LINES = 200;
/** Bound a single candidate line before token-budget accounting/appending. */
export const MAX_EXPAND_LINE_CHARS = 64 * 1024;
const EXPAND_TRUNCATION_MARKER = '\n// [Truncated] Output exceeded the requested token budget.\n';

function boundedNumber(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_EXPAND_WINDOW_LINES, Math.max(0, Math.floor(value)));
}

export function extractTermWindows(
  filePath: string,
  terms: string[],
  opts: WindowOptions = {}
): string {
  if (!fs.existsSync(filePath)) {
    return `File not found: ${filePath}`;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return `File not found: ${filePath}`;
  }
  if (!stat.isFile()) return `Not a regular file: ${filePath}`;
  if (stat.size > MAX_EXPAND_FILE_BYTES) {
    return `File too large to expand (maximum ${MAX_EXPAND_FILE_BYTES} bytes): ${filePath}`;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  const maxTokens = Math.min(
    MAX_EXPAND_FILE_TOKENS,
    Math.max(1, Math.floor(opts.maxTokens ?? MAX_EXPAND_FILE_TOKENS))
  );
  const before = boundedNumber(opts.linesBefore, 5);
  const after = boundedNumber(opts.linesAfter, 5);

  const matchLines: number[] = [];
  const safeTerms = terms
    .slice(0, MAX_EXPAND_TERMS)
    .map((term) => term.slice(0, MAX_EXPAND_TERM_LENGTH));
  const lowerTerms = safeTerms.map((t) => t.toLowerCase());

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
    return `No matches found for terms [${safeTerms.join(', ')}] in ${filePath}`;
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
      // Check the complete candidate before appending. A single very long
      // matching line used to be appended wholesale and only then noticed,
      // defeating the token budget and response cap.
      const line = lines[j].slice(0, MAX_EXPAND_LINE_CHARS);
      const candidate = `${out}${line}\n`;
      if (estimateTokens(candidate) > maxTokens) {
        out += EXPAND_TRUNCATION_MARKER;
        return out.trim();
      }
      out = candidate;
    }
  }

  return out.trim();
}
