import fs from 'node:fs';
import path from 'node:path';

/**
 * Return the canonical workspace root for path validation.
 * Mirrors the resolution used across the MCP tools.
 */
export function getWorkspaceRoot(): string {
  return process.env.CONTEXTOS_REPO_ROOT || process.cwd();
}

/**
 * Resolve `inputPath` against `root` and return the resolved absolute path ONLY
 * if it stays inside the workspace root even after following symlinks. Returns
 * `null` when the path escapes the workspace via an absolute path, a `..`
 * segment, or a symlink that points outside the root.
 *
 * Why this exists: `path.resolve` is purely lexical and never touches the
 * filesystem, so a lexical `startsWith(root)` check cannot detect a symlink
 * committed inside a (potentially hostile) repository. We `realpath` both the
 * target — or its nearest existing ancestor, when the final path does not exist
 * yet — and the root, then compare the real paths. This is the standard fix for
 * symlink-based sandbox escapes.
 */
export function resolveWithinWorkspace(root: string, inputPath: string): string | null {
  const resolved = path.resolve(root, inputPath);
  const realRoot = safeRealpath(root);
  const realResolved = realpathAllowingMissing(resolved);
  if (realRoot === null || realResolved === null) return null;
  if (realResolved === realRoot || realResolved.startsWith(realRoot + path.sep)) {
    return resolved;
  }
  return null;
}

function safeRealpath(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * `realpath` the deepest existing ancestor of `p`, then re-append the trailing
 * segments that do not exist yet. This lets us validate a not-yet-created path
 * (e.g. a file about to be written) while still dereferencing any symlink in its
 * existing prefix.
 */
function realpathAllowingMissing(p: string): string | null {
  let current = p;
  const trailing: string[] = [];
  // Walk up until we hit an existing ancestor (or the filesystem root).
  for (;;) {
    if (fs.existsSync(current)) {
      const real = safeRealpath(current);
      if (real === null) return null;
      return trailing.length ? path.join(real, ...trailing.reverse()) : real;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // Reached the filesystem root without finding an existing path — fail closed.
      return null;
    }
    trailing.push(path.basename(current));
    current = parent;
  }
}
