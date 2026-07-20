import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { onFileRead } from './feedback.js';

function getWorkspaceRoot(): string {
  return process.env.CONTEXTOS_REPO_ROOT || process.cwd();
}

function isInsideWorkspace(resolvedPath: string, root: string): boolean {
  const rootResolved = path.resolve(root);
  return resolvedPath === rootResolved || resolvedPath.startsWith(rootResolved + path.sep);
}

export function registerReadFileTool(server: McpServer) {
  server.tool(
    'ctx_read_file',
    'Read a file (or a line range) when get_context stubs or truncates. Prefer start_line/end_line from stub paths (e.g. path.ts:12-84) over whole-file reads. Prefer get_symbol when you only need one named symbol. Max 2000 lines per call.',
    {
      filePath: z.string().describe('The absolute or relative path to the file to read'),
      start_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('1-based start line (inclusive). Use with end_line for ranged reads from stubs.'),
      end_line: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          '1-based end line (inclusive). Defaults to start_line + 199 if only start_line is set.'
        )
    },
    async ({ filePath, start_line, end_line }) => {
      try {
        const root = getWorkspaceRoot();
        const resolvedPath = path.resolve(root, filePath);

        if (!isInsideWorkspace(resolvedPath, root)) {
          return {
            content: [
              { type: 'text', text: `Access denied: path is outside workspace root (${root}).` }
            ],
            isError: true
          };
        }

        if (!fs.existsSync(resolvedPath)) {
          return {
            content: [{ type: 'text', text: `File not found: ${resolvedPath}` }],
            isError: true
          };
        }

        const stat = fs.statSync(resolvedPath);
        if (stat.isDirectory()) {
          return {
            content: [{ type: 'text', text: `Path is a directory, not a file: ${resolvedPath}` }],
            isError: true
          };
        }

        // Limit file size to avoid memory explosion (e.g., max 1MB)
        if (stat.size > 1024 * 1024) {
          return {
            content: [
              {
                type: 'text',
                text: `File is too large (> 1MB) to be read via this tool: ${resolvedPath}`
              }
            ],
            isError: true
          };
        }

        // B7: implicit positive feedback for chunks from this file after recent get_context
        onFileRead(resolvedPath);

        const content = fs.readFileSync(resolvedPath, 'utf8');
        const lines = content.split('\n');
        const MAX_LINES = 2000;

        let startIdx = 0;
        let endIdx = Math.min(lines.length, MAX_LINES);
        let ranged = false;

        if (start_line != null) {
          ranged = true;
          startIdx = Math.max(0, start_line - 1);
          const defaultEnd = startIdx + MAX_LINES;
          endIdx =
            end_line != null
              ? Math.min(lines.length, end_line)
              : Math.min(lines.length, defaultEnd);
          if (endIdx <= startIdx) {
            return {
              content: [
                {
                  type: 'text',
                  text: `Invalid range: start_line=${start_line} end_line=${end_line ?? 'default'}`
                }
              ],
              isError: true
            };
          }
          // Cap ranged reads too
          if (endIdx - startIdx > MAX_LINES) {
            endIdx = startIdx + MAX_LINES;
          }
        }

        let output = lines.slice(startIdx, endIdx).join('\n');
        const header = ranged
          ? `--- From ${resolvedPath} (lines ${startIdx + 1}-${endIdx}) ---`
          : `--- From ${resolvedPath} ---`;

        if (!ranged && lines.length > MAX_LINES) {
          output += `\n\n[...truncated to ${MAX_LINES} lines]`;
        } else if (ranged && endIdx < lines.length && end_line != null && endIdx < end_line) {
          output += `\n\n[...truncated to ${MAX_LINES} lines within requested range]`;
        }

        return {
          content: [
            {
              type: 'text',
              text: `${header}\n\n${output}`
            }
          ]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error reading file: ${error.message}` }],
          isError: true
        };
      }
    }
  );
}
