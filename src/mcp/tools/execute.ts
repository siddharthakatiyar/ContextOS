import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'node:path';
import { getWorkspaceRoot, resolveWithinWorkspace } from '../../utils/fs-guard.js';
import { validateCommandArguments } from '../../utils/command-guard.js';
import { loadConfig } from '../../config/index.js';
import { getErrorMessage } from '../../utils/errors.js';

const execFileAsync = promisify(execFile);

/**
 * Whether ctx_execute may run the target repository's own scripts (npm/npx),
 * which execute attacker-controlled package.json scripts / test files on a
 * hostile repo. Default OFF; enable via config `execAllowRepoScripts: true`
 * or env `CONTEXTOS_EXEC_ALLOW_SCRIPTS=1` for trusted repositories.
 */
export function repoScriptsAllowed(): boolean {
  const env = process.env.CONTEXTOS_EXEC_ALLOW_SCRIPTS;
  if (env !== undefined && env !== '') {
    return env !== '0' && env.toLowerCase() !== 'false';
  }
  try {
    return loadConfig({ cwd: getWorkspaceRoot() }).execAllowRepoScripts !== false;
  } catch {
    return false;
  }
}

/**
 * Keep child processes useful for local builds while excluding ambient secrets
 * and runtime redirection knobs such as NODE_OPTIONS and npm_config_prefix.
 * This is an environment filter, not a process sandbox.
 */
export function buildExecutionEnv(cwd?: string): NodeJS.ProcessEnv {
  const allowedExact = new Set([
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'ComSpec',
    'CI',
    'NODE_ENV',
    'LANG',
    'LC_ALL',
    'LC_CTYPE',
    'LC_COLLATE'
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowedExact) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (cwd) {
    // Force npm/npx writes and package resolution back under the validated cwd;
    // ambient npm_config_* values and user-level .npmrc files are untrusted.
    env.npm_config_prefix = cwd;
    env.npm_config_global = 'false';
    env.npm_config_cache = path.join(cwd, '.contextos', 'npm-cache');
    env.npm_config_userconfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  }
  return env;
}

/** Dangerous find(1) predicates that can execute commands or delete files. */
const FIND_DANGEROUS_FLAGS = new Set(['-exec', '-execdir', '-delete', '-ok', '-okdir']);

function hasDangerousFindFlag(args: string[]): boolean {
  return args.some((arg) => FIND_DANGEROUS_FLAGS.has(arg.toLowerCase()));
}

/** Block git flags that write output to an arbitrary file. */
function hasDangerousGitOutputFlag(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const lower = arg.toLowerCase();
    if (lower === '--output' || lower.startsWith('--output=')) {
      return true;
    }
    // `-o` as output-redirect style (standalone or `-o<path>`)
    if (lower === '-o' || (lower.startsWith('-o') && lower.length > 2 && !lower.startsWith('--'))) {
      return true;
    }
  }
  return false;
}

function hasShortFlag(arg: string, flag: string): boolean {
  return arg.startsWith('-') && !arg.startsWith('--') && arg.slice(1).includes(flag);
}

/** Reject options that make an allowed filesystem command follow symlinks. */
export function validateSymlinkFollowOptions(exe: string, args: readonly string[]): string | null {
  const command = exe.toLowerCase();
  const lowerArgs = args.map((arg) => arg.toLowerCase());

  if (
    lowerArgs.some(
      (arg) => arg === '--follow' || arg.startsWith('--follow=') || arg.startsWith('--dereference')
    )
  ) {
    return 'Symlink-following options are not allowed for confined execution.';
  }

  if (
    command === 'find' &&
    args.some((arg) => arg.toLowerCase() === '-follow' || hasShortFlag(arg, 'L'))
  ) {
    return 'find symlink-following options (-L, -follow) are not allowed.';
  }

  if (
    command === 'grep' &&
    args.some((arg) => arg.toLowerCase() === '--dereference-recursive' || hasShortFlag(arg, 'R'))
  ) {
    return 'grep recursive symlink-following options (-R, --dereference-recursive) are not allowed.';
  }

  if (
    command === 'ls' &&
    args.some((arg) => arg.toLowerCase() === '--dereference' || hasShortFlag(arg, 'L'))
  ) {
    return 'ls symlink-dereference options (-L, --dereference) are not allowed.';
  }

  // `tree -l` treats links to directories as directories; combined short
  // forms such as -al must be rejected as well.
  if (command === 'tree' && args.some((arg) => hasShortFlag(arg, 'l'))) {
    return 'tree symlink-following option (-l) is not allowed.';
  }

  return null;
}

export function registerExecuteTool(server: McpServer) {
  server.tool(
    'ctx_execute',
    'Execute a shell command within the workspace. Use this to run tests, build the project, or check status. SECURITY WARNING: Only allowed commands are permitted (ls, cat, head, tail, wc, find, grep, tree, npm, npx, tsc, git). Directory traversal outside cwd is not allowed.',
    {
      command: z.string().describe('The shell command to execute'),
      cwd: z
        .string()
        .optional()
        .describe('Working directory for the command (defaults to current directory)')
    },
    async ({ command, cwd }) => {
      try {
        const cmdParts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
        if (cmdParts.length === 0) {
          return { content: [{ type: 'text', text: 'Empty command.' }], isError: true };
        }

        const exe = cmdParts[0] as string;
        const args: string[] = cmdParts.slice(1).map((arg) => {
          if (
            (arg.startsWith('"') && arg.endsWith('"')) ||
            (arg.startsWith("'") && arg.endsWith("'"))
          ) {
            return arg.slice(1, -1);
          }
          return arg;
        });

        const allowedCommands = [
          'ls',
          'cat',
          'head',
          'tail',
          'wc',
          'find',
          'grep',
          'tree',
          'npm',
          'npx',
          'tsc',
          'git'
        ];

        if (!allowedCommands.includes(exe)) {
          return {
            content: [
              {
                type: 'text',
                text: `Command not allowed. Allowed executables are: ${allowedCommands.join(', ')}`
              }
            ],
            isError: true
          };
        }

        const symlinkOptionError = validateSymlinkFollowOptions(exe, args);
        if (symlinkOptionError) {
          return {
            content: [{ type: 'text', text: symlinkOptionError }],
            isError: true
          };
        }

        if (exe === 'find' && hasDangerousFindFlag(args)) {
          return {
            content: [
              {
                type: 'text',
                text: 'Dangerous find flags (-exec, -execdir, -delete, -ok, -okdir) are not allowed.'
              }
            ],
            isError: true
          };
        }

        if ((exe === 'npm' || exe === 'npx') && !repoScriptsAllowed()) {
          return {
            content: [
              {
                type: 'text',
                text: "Running repository scripts (npm/npx) is disabled. These execute the indexed repository's own package.json scripts / test files, which is unsafe on untrusted repos. Enable for trusted repositories via config `execAllowRepoScripts: true` or env `CONTEXTOS_EXEC_ALLOW_SCRIPTS=1`."
              }
            ],
            isError: true
          };
        }

        if (exe === 'npm') {
          if (args[0] !== 'test' && args[0] !== 'run') {
            return {
              content: [
                { type: 'text', text: `Arbitrary npm commands are not allowed. Allowed: test, run` }
              ],
              isError: true
            };
          }
          if (args[0] === 'run') {
            const allowedScripts = ['test', 'build', 'lint'];
            if (!allowedScripts.includes(args[1])) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `Arbitrary npm run scripts are not allowed. Allowed scripts: ${allowedScripts.join(', ')}`
                  }
                ],
                isError: true
              };
            }
          }
        }

        if (exe === 'npx') {
          const allowedNpx = ['vitest', 'jest'];
          if (!allowedNpx.includes(args[0])) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Arbitrary npx commands are not allowed. Allowed: ${allowedNpx.join(', ')}`
                }
              ],
              isError: true
            };
          }
        }

        if (exe === 'git') {
          const allowedGit = ['status', 'log', 'diff', 'branch'];
          if (!allowedGit.includes(args[0])) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Arbitrary git commands are not allowed. Allowed: ${allowedGit.join(', ')}`
                }
              ],
              isError: true
            };
          }
          if (hasDangerousGitOutputFlag(args)) {
            return {
              content: [
                { type: 'text', text: 'Git output-redirect flags (--output, -o) are not allowed.' }
              ],
              isError: true
            };
          }
        }

        const root = getWorkspaceRoot();
        const targetCwd = cwd || root;
        const resolvedCwd = resolveWithinWorkspace(root, targetCwd);
        if (resolvedCwd === null) {
          return {
            content: [
              { type: 'text', text: `Execution outside workspace root (${root}) is not allowed.` }
            ],
            isError: true
          };
        }

        // Validate ordinary operands and the values hidden inside command
        // options such as npm's --prefix=../outside form.
        const argumentError = validateCommandArguments(root, resolvedCwd, args);
        if (argumentError) {
          return {
            content: [{ type: 'text', text: argumentError }],
            isError: true
          };
        }

        const { stdout, stderr } = await execFileAsync(exe, args, {
          cwd: resolvedCwd,
          env: buildExecutionEnv(exe === 'npm' || exe === 'npx' ? resolvedCwd : undefined),
          timeout: 30000,
          maxBuffer: 1024 * 1024
        });

        const capOutput = (output: string) => {
          const lines = output.split('\n');
          if (lines.length <= 250) return output;
          const head = lines.slice(0, 200).join('\n');
          const tail = lines.slice(lines.length - 50).join('\n');
          return `${head}\n\n... [${lines.length - 250} lines omitted by ContextOS] ...\n\n${tail}`;
        };

        let output = '';
        if (stdout) output += `STDOUT:\n${capOutput(stdout)}\n`;
        if (stderr) output += `STDERR:\n${capOutput(stderr)}\n`;

        return {
          content: [
            { type: 'text', text: output || 'Command completed successfully with no output.' }
          ]
        };
      } catch (error) {
        const capOutput = (output: string) => {
          if (!output) return '';
          const lines = output.split('\n');
          if (lines.length <= 250) return output;
          const head = lines.slice(0, 200).join('\n');
          const tail = lines.slice(lines.length - 50).join('\n');
          return `${head}\n\n... [${lines.length - 250} lines omitted by ContextOS] ...\n\n${tail}`;
        };
        const failure =
          typeof error === 'object' && error !== null
            ? (error as { code?: unknown; stdout?: unknown; stderr?: unknown })
            : {};
        const exitCode =
          typeof failure.code === 'string' || typeof failure.code === 'number'
            ? failure.code
            : 'unknown';
        const stdoutText = typeof failure.stdout === 'string' ? failure.stdout : '';
        const stderrText = typeof failure.stderr === 'string' ? failure.stderr : '';
        return {
          content: [
            {
              type: 'text',
              text: `Command failed with exit code ${exitCode}:\n\nSTDOUT:\n${capOutput(stdoutText)}\n\nSTDERR:\n${capOutput(stderrText)}\n\nError Message:\n${getErrorMessage(error)}`
            }
          ],
          isError: true
        };
      }
    }
  );
}
