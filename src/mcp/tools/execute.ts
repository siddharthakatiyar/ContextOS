import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { execFile } from "child_process";
import { promisify } from "util";
import path from "path";

const execFileAsync = promisify(execFile);

/** Dangerous find(1) predicates that can execute commands or delete files. */
const FIND_DANGEROUS_FLAGS = new Set([
  '-exec', '-execdir', '-delete', '-ok', '-okdir',
]);

function hasDangerousFindFlag(args: string[]): boolean {
  return args.some(arg => FIND_DANGEROUS_FLAGS.has(arg.toLowerCase()));
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

export function registerExecuteTool(server: McpServer) {
  server.tool(
    "ctx_execute",
    "Execute a shell command within the workspace. Use this to run tests, build the project, or check status. SECURITY WARNING: Only allowed commands are permitted (ls, cat, head, tail, wc, find, grep, tree, npm, npx, tsc, git). Directory traversal outside cwd is not allowed.",
    {
      command: z.string().describe("The shell command to execute"),
      cwd: z.string().optional().describe("Working directory for the command (defaults to current directory)"),
    },
    async ({ command, cwd }) => {
      try {
        const cmdParts = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
        if (cmdParts.length === 0) {
          return { content: [{ type: "text", text: "Empty command." }], isError: true };
        }
        
        const exe = cmdParts[0] as string;
        const args: string[] = cmdParts.slice(1).map(arg => {
          if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
            return arg.slice(1, -1);
          }
          return arg;
        });

        const allowedCommands = [
          'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'tree',
          'npm', 'npx', 'tsc', 'git'
        ];
        
        if (!allowedCommands.includes(exe)) {
          return {
            content: [{ type: "text", text: `Command not allowed. Allowed executables are: ${allowedCommands.join(', ')}` }],
            isError: true,
          };
        }

        if (exe === 'find' && hasDangerousFindFlag(args)) {
          return {
            content: [{ type: "text", text: "Dangerous find flags (-exec, -execdir, -delete, -ok, -okdir) are not allowed." }],
            isError: true,
          };
        }

        if (exe === 'npm') {
          if (args[0] !== 'test' && args[0] !== 'run') {
            return {
              content: [{ type: "text", text: `Arbitrary npm commands are not allowed. Allowed: test, run` }],
              isError: true,
            };
          }
          if (args[0] === 'run') {
            const allowedScripts = ['test', 'build', 'lint'];
            if (!allowedScripts.includes(args[1])) {
              return {
                content: [{ type: "text", text: `Arbitrary npm run scripts are not allowed. Allowed scripts: ${allowedScripts.join(', ')}` }],
                isError: true,
              };
            }
          }
        }

        if (exe === 'npx') {
          const allowedNpx = ['vitest', 'jest'];
          if (!allowedNpx.includes(args[0])) {
            return {
              content: [{ type: "text", text: `Arbitrary npx commands are not allowed. Allowed: ${allowedNpx.join(', ')}` }],
              isError: true,
            };
          }
        }

        if (exe === 'git') {
          const allowedGit = ['status', 'log', 'diff', 'branch'];
          if (!allowedGit.includes(args[0])) {
            return {
              content: [{ type: "text", text: `Arbitrary git commands are not allowed. Allowed: ${allowedGit.join(', ')}` }],
              isError: true,
            };
          }
          if (hasDangerousGitOutputFlag(args)) {
            return {
              content: [{ type: "text", text: "Git output-redirect flags (--output, -o) are not allowed." }],
              isError: true,
            };
          }
        }

        for (const arg of args) {
          if (path.isAbsolute(arg) || arg.startsWith('/')) {
            return {
              content: [{ type: "text", text: "Absolute paths are not allowed in arguments." }],
              isError: true,
            };
          }
          if (arg.includes('../') || arg.includes('..\\')) {
            return {
              content: [{ type: "text", text: "Directory traversal is not allowed in arguments." }],
              isError: true,
            };
          }
        }

        const targetCwd = cwd || process.cwd();
        const root = process.env.CONTEXTOS_REPO_ROOT || process.cwd();
        const resolvedCwd = path.resolve(targetCwd);
        const rootResolved = path.resolve(root);
        if (resolvedCwd !== rootResolved && !resolvedCwd.startsWith(rootResolved + path.sep)) {
          return {
            content: [{ type: "text", text: `Execution outside workspace root (${root}) is not allowed.` }],
            isError: true,
          };
        }

        const { stdout, stderr } = await execFileAsync(exe, args, { 
          cwd: resolvedCwd,
          timeout: 30000,
          maxBuffer: 1024 * 1024
        });
        
        let output = "";
        if (stdout) output += `STDOUT:\n${stdout}\n`;
        if (stderr) output += `STDERR:\n${stderr}\n`;

        return {
          content: [{ type: "text", text: output || "Command completed successfully with no output." }],
        };
      } catch (error: any) {
        return {
          content: [
            { 
              type: "text", 
              text: `Command failed with exit code ${error.code}:\n\nSTDOUT:\n${error.stdout || ''}\n\nSTDERR:\n${error.stderr || ''}\n\nError Message:\n${error.message}` 
            }
          ],
          isError: true,
        };
      }
    }
  );
}
