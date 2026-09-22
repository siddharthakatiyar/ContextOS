import path from 'node:path';
import { resolveWithinWorkspace } from './fs-guard.js';

/** Options whose value is interpreted as a filesystem path by common tools. */
const PATH_VALUE_OPTIONS = new Set([
  '--cache',
  '--config',
  '--declarationDir',
  '--dir',
  '--exclude-from',
  '--files-from',
  '--git-dir',
  '--include-from',
  '--logs-dir',
  '--outDir',
  '--prefix',
  '--project',
  '--root',
  '--rootDir',
  '--script-shell',
  '--tsBuildInfoFile',
  '--userconfig',
  '--watchDirectory',
  '--work-tree',
  '--workspace',
  '--workspace-root',
  '-C',
  '-I',
  '-f',
  '-o',
  '-p'
]);

/** Short options that may carry a path without a separating space. */
const SHORT_PATH_PREFIXES = ['-C', '-I', '-f', '-o', '-p'];

const REJECTED_OPTIONS = new Set([
  '--global',
  '-g',
  '--location',
  '--location=global',
  '--location=system',
  '--script-shell'
]);

function pathError(root: string, cwd: string, value: string): string | null {
  if (!value || value === '--') return null;
  if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('~')) {
    return `Absolute paths are not allowed in arguments (${value}).`;
  }

  const resolved = path.resolve(cwd, value);
  if (resolveWithinWorkspace(root, resolved) === null) {
    return `Directory traversal is not allowed in arguments (${value}).`;
  }
  return null;
}

function optionName(arg: string): string | null {
  const equals = arg.indexOf('=');
  return equals > 0 ? arg.slice(0, equals) : null;
}

function optionValue(arg: string): string | null {
  const equals = arg.indexOf('=');
  return equals > 0 ? arg.slice(equals + 1) : null;
}

function looksLikePath(value: string): boolean {
  return (
    value === '.' ||
    value === '..' ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('~') ||
    value.includes('/') ||
    value.includes('\\') ||
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function shortPathValue(arg: string): { option: string; value: string } | null {
  for (const prefix of SHORT_PATH_PREFIXES) {
    if (arg.startsWith(prefix) && arg.length > prefix.length) {
      const value = arg.slice(prefix.length).replace(/^=/, '');
      return { option: prefix, value };
    }
  }
  return null;
}

/**
 * Validate path-bearing command arguments after the command's cwd has been
 * validated. The old guard treated `--prefix=../outside` as one opaque string;
 * command-line programs interpret the value after `=` as a path instead.
 *
 * This is argument confinement, not an OS sandbox: an explicitly enabled repo
 * script can still access anything available to its process. Untrusted code
 * requires a process/container sandbox in addition to this check.
 */
export function validateCommandArguments(
  root: string,
  cwd: string,
  args: readonly string[]
): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';

    const name = optionName(arg);
    const value = optionValue(arg);
    if (
      REJECTED_OPTIONS.has(arg) ||
      (name && (REJECTED_OPTIONS.has(name) || (name === '--location' && value === 'global')))
    ) {
      return `Option is not allowed for confined execution (${arg}).`;
    }

    if (name && value !== null && (PATH_VALUE_OPTIONS.has(name) || looksLikePath(value))) {
      const error = pathError(root, cwd, value);
      if (error) return error;
    }

    const short = shortPathValue(arg);
    if (short) {
      const error = pathError(root, cwd, short.value);
      if (error) return error;
    }

    if (PATH_VALUE_OPTIONS.has(arg)) {
      const next = args[i + 1];
      if (next === undefined || next === '--') {
        return `${arg} requires a path value.`;
      }
      const error = pathError(root, cwd, next);
      if (error) return error;
    }

    // Preserve the existing safety property for ordinary operands. This also
    // catches a path supplied after an option in split form.
    if (path.isAbsolute(arg) || arg.startsWith('/')) {
      return `Absolute paths are not allowed in arguments (${arg}).`;
    }
    const error = pathError(root, cwd, arg);
    if (error) return error;
  }
  return null;
}
