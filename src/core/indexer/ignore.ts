import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import { minimatch } from 'minimatch';

type IgnoreManager = ReturnType<typeof ignore>;

/** Safety exclusions are unconditional; user negation rules cannot re-enable them. */
export const SAFETY_IGNORE_PATTERNS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/target/**',
  '**/*.min.js',
  '**/*.min.css',
  '**/*.map',
  '**/*.lock',
  '**/vendor/**',
  '**/.contextos/**',
  'Library/**',
  'Applications/**',
  'Downloads/**',
  'Pictures/**',
  'Music/**',
  'Movies/**',
  'go/pkg/**',
  'Desktop/**'
] as const;

export interface IndexIgnore {
  readonly root: string;
  /** Patterns safe to pass to glob for traversal pruning. */
  readonly globIgnore: readonly string[];
  /** Test an absolute path against safety, config, and root ignore files. */
  ignores(absolutePath: string): boolean;
}

function readRootIgnoreFile(root: string, name: string): string[] {
  const filePath = path.join(root, name);
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[ContextOS] Could not read ${filePath}: ${(error as Error).message}`);
    }
    return [];
  }
}

function addPatterns(manager: IgnoreManager, patterns: readonly string[], source: string): void {
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (!trimmed) continue;
    try {
      manager.add(trimmed);
    } catch (error) {
      // A malformed optional rule must not disable indexing or safety rules.
      console.warn(
        `[ContextOS] Ignoring invalid pattern in ${source}: ${trimmed} (${(error as Error).message})`
      );
    }
  }
}

/**
 * `ignorePatterns` is a configuration API that historically accepted glob
 * patterns (and therefore supports minimatch features such as braces). Keep it
 * separate from repository ignore files, whose lines intentionally use
 * gitignore semantics and ordered negations.
 */
function configuredPatternMatches(
  relative: string,
  patterns: readonly string[],
  source: string
): boolean {
  let ignored = false;
  for (const configuredPattern of patterns) {
    const trimmed = configuredPattern.trim();
    if (!trimmed) continue;

    // Support ordered negation for callers that used it with the old glob
    // traversal. A negation can re-include a configured path, while built-in
    // safety rules remain enforced independently below.
    const isNegated = trimmed.startsWith('!') && !trimmed.startsWith('\\!');
    const pattern = isNegated ? trimmed.slice(1) : trimmed;
    if (!pattern) continue;
    try {
      if (minimatch(relative, pattern, { dot: true, nocase: process.platform === 'win32' })) {
        ignored = !isNegated;
      }
    } catch (error) {
      // A malformed optional rule must not disable indexing or safety rules.
      console.warn(
        `[ContextOS] Ignoring invalid pattern in ${source}: ${trimmed} (${(error as Error).message})`
      );
    }
  }
  return ignored;
}

/**
 * Resolve the existing portion of a path while preserving a nonexistent leaf.
 * This keeps lexical event paths under canonical roots on systems such as
 * macOS, where `/var` is an alias for `/private/var`.
 */
export function canonicalPathForComparison(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const suffix: string[] = [];
  let current = resolved;
  while (true) {
    try {
      const canonical = fs.realpathSync(current);
      return path.join(canonical, ...suffix.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return resolved;
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function relativePath(root: string, absolutePath: string): string | null {
  const resolved = canonicalPathForComparison(absolutePath);
  const relative = path.relative(root, resolved).split(path.sep).join('/');
  if (!relative || relative === '.') return '';
  if (relative === '..' || relative.startsWith('../')) return null;
  return relative;
}

/**
 * Build one ignore policy for bulk, watch, and explicit indexing paths.
 * `.gitignore` and `.contextosignore` are intentionally root-only; nested
 * ignore files are not loaded until their precedence can be defined clearly.
 */
export function createIndexIgnore(
  rootInput: string,
  configuredPatterns: readonly string[] = []
): IndexIgnore {
  const lexicalRoot = path.resolve(rootInput);
  const root = canonicalPathForComparison(lexicalRoot);
  const safety = ignore();
  addPatterns(safety, SAFETY_IGNORE_PATTERNS, 'built-in safety rules');

  const user = ignore();
  const gitignore = readRootIgnoreFile(root, '.gitignore');
  const contextosignore = readRootIgnoreFile(root, '.contextosignore');
  addPatterns(user, gitignore, path.join(root, '.gitignore'));
  addPatterns(user, contextosignore, path.join(root, '.contextosignore'));

  // Only unconditional rules are used to prune glob traversal. User rules are
  // applied after discovery so a negation can re-include a path correctly.
  const globIgnore = [...SAFETY_IGNORE_PATTERNS];

  return {
    root,
    globIgnore,
    ignores(absolutePath: string): boolean {
      const relative = relativePath(root, absolutePath);
      if (relative === null) return true;
      if (!relative) return false;
      return (
        safety.ignores(relative) ||
        safety.ignores(`${relative}/`) ||
        configuredPatternMatches(relative, configuredPatterns, 'configuration') ||
        user.ignores(relative) ||
        user.ignores(`${relative}/`)
      );
    }
  };
}
