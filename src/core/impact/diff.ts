import { execFileSync } from 'node:child_process';

export interface LineRange {
  start: number;
  end: number;
}
export interface DiffHunk {
  oldStart: number;
  newStart: number;
  oldCount: number;
  newCount: number;
  lines: string[];
}
export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  ranges: LineRange[];
  oldRanges: LineRange[];
  hunks?: DiffHunk[];
}

function gitPath(value: string, stripPrefix = true): string {
  let raw = value.split('\t')[0];
  if (value.startsWith('"')) {
    const bytes: number[] = [];
    for (let i = 1; i < value.length - 1; i++) {
      if (value[i] === '\\') {
        const octal = /^[0-7]{3}/.exec(value.slice(i + 1));
        if (octal) {
          bytes.push(Number.parseInt(octal[0], 8));
          i += 3;
        } else {
          const escaped = value[++i];
          const decoded = (
            {
              n: '\n',
              t: '\t',
              r: '\r',
              b: '\b',
              f: '\f',
              v: '\v',
              '\\': '\\',
              '"': '"'
            } as Record<string, string>
          )[escaped];
          if (decoded === undefined) throw new Error('Invalid quoted diff path.');
          bytes.push(...Buffer.from(decoded));
        }
      } else {
        const codepoint = value.codePointAt(i)!;
        bytes.push(...Buffer.from(String.fromCodePoint(codepoint)));
        if (codepoint > 0xffff) i++;
      }
    }
    raw = Buffer.from(bytes).toString('utf8');
  }
  return stripPrefix ? raw.replace(/^[ab]\//, '') : raw;
}

/** Context lines are deliberately excluded from changed ranges. Both coordinate systems survive. */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  if (Buffer.byteLength(diff) > 4 * 1024 * 1024) throw new Error('Diff exceeds 4 MiB.');
  const files: ChangedFile[] = [];
  let file: ChangedFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLine = 0,
    newLine = 0;
  let oldRemaining = 0,
    newRemaining = 0;
  const add = (ranges: LineRange[], line: number) => {
    const last = ranges.at(-1);
    if (last && last.end + 1 === line) last.end = line;
    else ranges.push({ start: Math.max(1, line), end: Math.max(1, line) });
  };
  for (const line of diff.split('\n')) {
    if (
      (line.startsWith('diff --git ') || line.startsWith('--- ')) &&
      !hunk &&
      (oldRemaining || newRemaining)
    )
      throw new Error('Incomplete diff hunk.');
    if (line.startsWith('diff --git ')) {
      file = undefined;
      hunk = undefined;
      continue;
    }
    if (line.startsWith('--- ') && !hunk) {
      const oldPath = gitPath(line.slice(4));
      file = { path: oldPath, oldPath, status: 'modified', ranges: [], oldRanges: [], hunks: [] };
      files.push(file);
      if (files.length > 1000) throw new Error('Diff exceeds 1000 files.');
      continue;
    }
    if (line.startsWith('+++ ') && file && !hunk) {
      const next = gitPath(line.slice(4));
      if (next === '/dev/null') file.status = 'deleted';
      else {
        file.path = next;
        file.status =
          file.oldPath === '/dev/null' ? 'added' : file.oldPath !== next ? 'renamed' : 'modified';
      }
      if (file.oldPath === '/dev/null') delete file.oldPath;
      continue;
    }
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header && file) {
      if (oldRemaining || newRemaining) throw new Error('Incomplete diff hunk.');
      oldLine = Number(header[1]);
      newLine = Number(header[3]);
      oldRemaining = Number(header[2] ?? 1);
      newRemaining = Number(header[4] ?? 1);
      hunk = {
        oldStart: oldLine,
        newStart: newLine,
        oldCount: oldRemaining,
        newCount: newRemaining,
        lines: []
      };
      file.hunks!.push(hunk);
    } else if (hunk && file && /^[ +-]/.test(line)) {
      hunk.lines.push(line);
      if (line[0] === '-') {
        add(file.oldRanges, oldLine++);
        oldRemaining--;
      } else if (line[0] === '+') {
        add(file.ranges, newLine++);
        newRemaining--;
      } else {
        oldLine++;
        newLine++;
        oldRemaining--;
        newRemaining--;
      }
      if (oldRemaining < 0 || newRemaining < 0) throw new Error('Invalid diff hunk counts.');
      if (!oldRemaining && !newRemaining) hunk = undefined;
    }
  }
  if (oldRemaining || newRemaining) throw new Error('Incomplete diff hunk.');
  // Git omits ---/+++ for pure renames and binary changes. Preserve them as whole-file changes.
  for (const block of diff.split(/(?=^diff --git )/m)) {
    if (!block.startsWith('diff --git ') || /^--- /m.test(block)) continue;
    const rename = /^rename from (.+)\nrename to (.+)$/m.exec(block);
    const names =
      /^diff --git (a\/.+) (b\/.+)$/.exec(block.split('\n')[0]) ??
      /^diff --git ("(?:\\.|[^"])*"|\S+) ("(?:\\.|[^"])*"|.+)$/m.exec(block);
    if (!names) continue;
    const oldPath = rename ? gitPath(rename[1], false) : gitPath(names[1]);
    const next = rename ? gitPath(rename[2], false) : gitPath(names[2]);
    files.push({
      path: next,
      oldPath,
      status: rename
        ? 'renamed'
        : /^deleted file/m.test(block)
          ? 'deleted'
          : /^new file/m.test(block)
            ? 'added'
            : 'modified',
      ranges: [],
      oldRanges: []
    });
  }
  if (files.length > 1000) throw new Error('Diff exceeds 1000 files.');
  if (diff.trim() && !files.length) throw new Error('No unified diff file headers found.');
  return files;
}

export function gitText(root: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: 'pipe',
    maxBuffer: 8 * 1024 * 1024
  });
}

/** Apply only when every old line matches; never fabricate a baseline from partial hunks. */
export function applyHunks(content: string, hunks: DiffHunk[]): string | undefined {
  const source = content.split('\n');
  const output: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    const start = Math.max(0, hunk.oldStart - (hunk.oldCount === 0 ? 0 : 1));
    if (start < cursor || start > source.length) return undefined;
    output.push(...source.slice(cursor, start));
    cursor = start;
    for (const line of hunk.lines) {
      if (line[0] !== '+') {
        if (source[cursor++] !== line.slice(1)) return undefined;
      }
      if (line[0] !== '-') output.push(line.slice(1));
    }
  }
  output.push(...source.slice(cursor));
  return output.join('\n');
}
