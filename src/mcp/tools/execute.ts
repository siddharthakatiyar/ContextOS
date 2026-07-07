import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";

const execAsync = promisify(exec);

export function registerExecuteTool(server: McpServer) {
  server.tool(
    "ctx_execute",
    "Execute a shell command within the workspace. Use this to run tests, build the project, or check status. SECURITY WARNING: Only allowed commands are permitted (ls, cat, head, tail, wc, find, grep, tree, npm test, npm run, npx, tsc, git). Directory traversal outside cwd is not allowed.",
    {
      command: z.string().describe("The shell command to execute"),
      cwd: z.string().optional().describe("Working directory for the command (defaults to current directory)"),
    },
    async ({ command, cwd }) => {
      try {
        const allowedCommands = [
          'ls', 'cat', 'head', 'tail', 'wc', 'find', 'grep', 'tree',
          'npm test', 'npm run', 'npx vitest', 'npx jest',
          'tsc',
          'git status', 'git log', 'git diff', 'git branch'
        ];
        const isAllowed = allowedCommands.some(cmd => command === cmd || command.startsWith(`${cmd} `));
        
        if (!isAllowed) {
          return {
            content: [{ type: "text", text: `Command not allowed. Allowed commands are: ${allowedCommands.join(', ')}` }],
            isError: true,
          };
        }

        // Security: block actual shell operators in the command structure
        // Strip all single-quoted and double-quoted strings, then check the remainder
        const stripped = command.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/'(?:[^'\\]|\\.)*'/g, "''");
        if (stripped.includes('cd ') || /[&|;\n\r`]/.test(stripped) || /\$\([^)]*\)/.test(stripped) || stripped.includes('${')) {
          return {
            content: [{ type: "text", text: "Command chaining, subshells, and directory changes are not allowed for security reasons." }],
            isError: true,
          };
        }
        
        // Security: tight cat rules
        if (command.startsWith('cat ') && command.includes(' /')) {
          return {
            content: [{ type: "text", text: "Reading absolute paths with cat is not allowed." }],
            isError: true,
          };
        }

        // Security: Validate cwd
        const targetCwd = cwd || process.cwd();
        const root = process.env.CONTEXTOS_REPO_ROOT || process.cwd();
        const resolvedCwd = path.resolve(targetCwd);
        if (!resolvedCwd.startsWith(path.resolve(root))) {
          return {
            content: [{ type: "text", text: `Execution outside workspace root (${root}) is not allowed.` }],
            isError: true,
          };
        }

        const { stdout, stderr } = await execAsync(command, { 
          cwd: resolvedCwd,
          timeout: 30000, // 30 second timeout
          maxBuffer: 1024 * 1024 // 1MB buffer limit
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
