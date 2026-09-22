import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

const NO_FOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function describe(p: string): string {
  return `ContextOS state path is not safe: ${p}`;
}

/**
 * macOS exposes the system temporary directory through aliases such as
 * `/var` -> `/private/var`. These aliases are outside application control;
 * allow them only when they are an ancestor of the canonical OS temp tree.
 */
function isTrustedTempAlias(inputPath: string): boolean {
  if (process.platform !== 'darwin' || !['/tmp', '/var'].includes(inputPath)) return false;
  const tempPath = path.resolve(os.tmpdir());
  if (tempPath !== inputPath && !tempPath.startsWith(`${inputPath}${path.sep}`)) {
    return false;
  }
  try {
    const canonicalInput = fs.realpathSync(inputPath);
    const canonicalTemp = fs.realpathSync(tempPath);
    return (
      canonicalTemp === canonicalInput || canonicalTemp.startsWith(`${canonicalInput}${path.sep}`)
    );
  } catch {
    return false;
  }
}

/** Reject symlinks in every existing component of a state path. */
export function assertNoSymlinkInPath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const segments = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);

  for (const segment of segments) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      throw new Error(`${describe(resolved)} (${(error as Error).message})`);
    }
    if (stat.isSymbolicLink() && !isTrustedTempAlias(current))
      throw new Error(`${describe(resolved)}: symlink component ${current}`);
  }
  return resolved;
}

/**
 * Create or tighten a ContextOS state directory. Existing user state is kept;
 * a symlink is rejected instead of being followed.
 */
export function ensurePrivateStateDir(inputPath: string): string {
  const resolved = assertNoSymlinkInPath(inputPath);
  try {
    fs.mkdirSync(resolved, { recursive: true, mode: PRIVATE_DIR_MODE });
  } catch (error) {
    throw new Error(`${describe(resolved)} (${(error as Error).message})`);
  }

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    throw new Error(`${describe(resolved)} (${(error as Error).message})`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${describe(resolved)}: expected a real directory`);
  }
  try {
    fs.chmodSync(resolved, PRIVATE_DIR_MODE);
  } catch (error) {
    throw new Error(`${describe(resolved)} cannot be made private (${(error as Error).message})`);
  }
  return resolved;
}

/** Ensure the parent state directory and reject a symlinked final path. */
export function preparePrivateStateFile(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  ensurePrivateStateDir(path.dirname(resolved));
  assertNoSymlinkInPath(resolved);

  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`${describe(resolved)}: expected a regular file`);
    }
    fs.chmodSync(resolved, PRIVATE_FILE_MODE);
  }
  return resolved;
}

/** Write a small state file without following a pre-existing symlink. */
export function writePrivateStateFile(inputPath: string, data: string): void {
  const resolved = preparePrivateStateFile(inputPath);
  const fd = fs.openSync(
    resolved,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NO_FOLLOW,
    PRIVATE_FILE_MODE
  );
  try {
    fs.writeFileSync(fd, data);
    fs.fchmodSync(fd, PRIVATE_FILE_MODE);
  } finally {
    fs.closeSync(fd);
  }
}

/** Make an existing state file private without changing its contents. */
export function tightenPrivateStateFile(inputPath: string): string {
  const resolved = preparePrivateStateFile(inputPath);
  if (fs.existsSync(resolved)) fs.chmodSync(resolved, PRIVATE_FILE_MODE);
  return resolved;
}

/** Remove an owner-private state file without following a symlinked path. */
export function removePrivateStateFile(inputPath: string): boolean {
  const resolved = path.resolve(inputPath);
  assertNoSymlinkInPath(resolved);
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`${describe(resolved)}: expected a regular file`);
    }
    fs.unlinkSync(resolved);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
    throw error;
  }
}

/** Canonicalize an existing project root before deriving state/socket paths. */
export function canonicalDirectory(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) throw new Error('not a directory');
    return fs.realpathSync(resolved);
  } catch (error) {
    throw new Error(
      `${describe(resolved)} project root is unavailable (${(error as Error).message})`
    );
  }
}

/**
 * Derive the Unix socket/named-pipe address shared by daemon and client.
 * The run directory is private before a socket is ever bound.
 */
export function getDaemonSocketPath(projectDir: string): string {
  const canonicalProject = canonicalDirectory(projectDir);
  if (process.platform === 'win32') {
    const nameHash = Buffer.from(canonicalProject).toString('hex');
    return path.join('\\\\?\\pipe', `contextos-${nameHash}`);
  }

  const contextHome = ensurePrivateStateDir(path.join(os.homedir(), '.contextos'));
  const runDir = ensurePrivateStateDir(path.join(contextHome, 'run'));
  const shortHash = crypto
    .createHash('md5')
    .update(canonicalProject)
    .digest('hex')
    .substring(0, 12);
  return path.join(runDir, `d-${shortHash}.sock`);
}

/** Tighten a newly bound Unix socket and reject a swapped-in symlink. */
export function secureBoundSocket(socketPath: string): void {
  const resolved = assertNoSymlinkInPath(socketPath);
  if (process.platform !== 'win32') fs.chmodSync(resolved, PRIVATE_FILE_MODE);
}
