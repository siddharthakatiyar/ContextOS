import fs from 'node:fs';
import path from 'node:path';

const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_SYMREF_DEPTH = 8;

function readOptional(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function assertRefName(ref: string): void {
  if (
    !ref.startsWith('refs/') ||
    /[~^:?*[\\]/.test(ref) ||
    [...ref].some(
      (character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127
    ) ||
    ref.includes('..') ||
    ref.includes('@{') ||
    ref
      .split('/')
      .some((part) => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))
  )
    throw new Error('Unsupported Git symbolic reference.');
}
function packedCommit(directory: string, ref: string): string | null {
  const contents = readOptional(path.join(directory, 'packed-refs'));
  if (contents === undefined) return null;
  let match: string | null = null;
  for (const line of contents.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error('Malformed Git packed reference.');
    const name = line.slice(space + 1);
    if (name !== ref) continue;
    const commit = line.slice(0, space);
    if (!OBJECT_ID.test(commit) || match !== null)
      throw new Error('Malformed or duplicate Git packed reference.');
    match = commit;
  }
  return match;
}

/** Resolve a captured HEAD using Git's files ref store without starting Git.
 * Missing refs mean an unborn branch. Unsupported storage, invalid refs, cycles,
 * and read failures throw so callers cannot mistake uncertain evidence for fresh.
 */
export function readGitCommit(gitDir: string, commonDir: string, head: string): string | null {
  for (const directory of new Set([gitDir, commonDir])) {
    if (!fs.statSync(directory).isDirectory())
      throw new Error('Git reference directory is unavailable.');
  }
  // Reftable does not maintain loose/packed refs; absence there cannot prove unborn HEAD.
  if (
    fs.existsSync(path.join(commonDir, 'reftable')) ||
    fs.existsSync(path.join(gitDir, 'reftable'))
  )
    throw new Error('Unsupported Git reference storage.');
  let current = head.trim();
  const visited = new Set<string>();
  for (let depth = 0; depth <= MAX_SYMREF_DEPTH; depth++) {
    if (OBJECT_ID.test(current)) return current;
    if (!current.startsWith('ref: ')) throw new Error('Malformed Git HEAD or symbolic reference.');
    const ref = current.slice(5);
    assertRefName(ref);
    if (visited.has(ref)) throw new Error('Cyclic Git symbolic reference.');
    visited.add(ref);
    const privateRef = /^refs\/(?:bisect|worktree|rewritten)\//.test(ref);
    const directory = privateRef ? gitDir : commonDir;
    const loose = readOptional(path.join(directory, ...ref.split('/')));
    if (loose === undefined) return packedCommit(directory, ref);
    current = loose.trim();
  }
  throw new Error('Git symbolic reference chain is too deep.');
}
