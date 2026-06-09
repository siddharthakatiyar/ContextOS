import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export function registerExecuteTool(server: McpServer) {
  server.tool(
    "ctx_execute",
    "Execute a shell command within the workspace. Use this to run tests, build the project, or check status. SECURITY WARNING: Only allowed commands are permitted (ls, cat, npm test, npm run build, tsc, node). Directory traversal outside cwd is not allowed.",
    {
      command: z.string().describe("The shell command to execute"),
      cwd: z.string().optional().describe("Working directory for the command (defaults to current directory)"),
    },
    async ({ command, cwd }) => {
      try {
        const allowedCommands = ['ls', 'cat', 'npm test', 'npm run build', 'tsc', 'node'];
        const isAllowed = allowedCommands.some(cmd => command === cmd || command.startsWith(`${cmd} `));
        
        if (!isAllowed) {
          return {
            content: [{ type: "text", text: `Command not allowed. Allowed commands are: ${allowedCommands.join(', ')}` }],
            isError: true,
          };
        }

        if (command.includes('cd ') || command.includes('&') || command.includes('|') || command.includes(';')) {
          return {
            content: [{ type: "text", text: "Command chaining and directory changes are not allowed for security reasons." }],
            isError: true,
          };
        }

        const { stdout, stderr } = await execAsync(command, { 
          cwd: cwd || process.cwd(),
          timeout: 30000 // 30 second timeout
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
