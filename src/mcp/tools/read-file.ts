import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { onFileRead } from "./feedback.js";

function getWorkspaceRoot(): string {
  return process.env.CONTEXTOS_REPO_ROOT || process.cwd();
}

function isInsideWorkspace(resolvedPath: string, root: string): boolean {
  const rootResolved = path.resolve(root);
  return resolvedPath === rootResolved || resolvedPath.startsWith(rootResolved + path.sep);
}

export function registerReadFileTool(server: McpServer) {
  server.tool(
    "ctx_read_file",
    "CRITICAL: Use this tool to read a full file when get_context truncates it. Reads up to 2000 lines of a file from the filesystem to avoid token limits while still providing deep context.",
    {
      filePath: z.string().describe("The absolute or relative path to the file to read"),
    },
    async ({ filePath }) => {
      try {
        const root = getWorkspaceRoot();
        const resolvedPath = path.resolve(root, filePath);

        if (!isInsideWorkspace(resolvedPath, root)) {
          return {
            content: [{ type: "text", text: `Access denied: path is outside workspace root (${root}).` }],
            isError: true,
          };
        }

        if (!fs.existsSync(resolvedPath)) {
          return {
            content: [{ type: "text", text: `File not found: ${resolvedPath}` }],
            isError: true,
          };
        }

        const stat = fs.statSync(resolvedPath);
        if (stat.isDirectory()) {
          return {
            content: [{ type: "text", text: `Path is a directory, not a file: ${resolvedPath}` }],
            isError: true,
          };
        }

        // Limit file size to avoid memory explosion (e.g., max 1MB)
        if (stat.size > 1024 * 1024) {
          return {
            content: [{ type: "text", text: `File is too large (> 1MB) to be read via this tool: ${resolvedPath}` }],
            isError: true,
          };
        }

        // B7: implicit positive feedback for chunks from this file after recent get_context
        onFileRead(resolvedPath);

        const content = fs.readFileSync(resolvedPath, "utf8");
        const lines = content.split('\n');

        const MAX_LINES = 2000;
        let output = lines.slice(0, MAX_LINES).join('\n');

        if (lines.length > MAX_LINES) {
          output += `\n\n[...truncated to ${MAX_LINES} lines]`;
        }

        return {
          content: [
            {
              type: "text",
              text: `--- From ${resolvedPath} ---\n\n${output}`,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error reading file: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
