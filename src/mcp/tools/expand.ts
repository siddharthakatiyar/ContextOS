import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  extractTermWindows,
  MAX_EXPAND_PATHS,
  MAX_EXPAND_RESPONSE_TOKENS,
  MAX_EXPAND_TERM_LENGTH,
  MAX_EXPAND_TERMS,
  MAX_EXPAND_WINDOW_LINES
} from '../../core/expand/window-extractor.js';
import { DB } from '../../core/storage/database.js';
import { getWorkspaceRoot, resolveWithinWorkspace } from '../../utils/fs-guard.js';
import { getErrorMessage } from '../../utils/errors.js';
import { estimateTokens } from '../../utils/tokens.js';

const expandPath = z.string().min(1).max(4096);
const expandTerm = z.string().min(1).max(MAX_EXPAND_TERM_LENGTH);
const RESPONSE_MARKER = '\n[Truncated: ctx_expand response limit reached.]\n';

function appendSection(
  output: string,
  requestedPath: string,
  content: string
): {
  output: string;
  truncated: boolean;
} {
  // Keep a hostile path label from consuming the whole response budget.
  const displayPath =
    requestedPath.length > 512 ? `${requestedPath.slice(0, 512)}…` : requestedPath;
  const section = `### ${displayPath}\n\`\`\`\n${content}\n\`\`\`\n\n`;
  if (estimateTokens(`${output}${section}`) <= MAX_EXPAND_RESPONSE_TOKENS) {
    return { output: `${output}${section}`, truncated: false };
  }
  return { output: `${output}${RESPONSE_MARKER}`, truncated: true };
}

export function registerExpandTool(server: McpServer, _dbs: DB[]) {
  server.tool(
    'ctx_expand',
    'Extract targeted windows of code around specific terms from files. Use this when get_context returns stubs and you need to peek at specific implementations without loading the entire file.',
    {
      paths: z
        .array(expandPath)
        .max(MAX_EXPAND_PATHS)
        .describe('List of file paths to extract from.'),
      terms: z
        .array(expandTerm)
        .max(MAX_EXPAND_TERMS)
        .describe('List of terms (symbols, identifiers, keywords) to search for in these files.'),
      linesBefore: z
        .number()
        .int()
        .min(0)
        .max(MAX_EXPAND_WINDOW_LINES)
        .optional()
        .describe('Number of lines to include before each match (default 5).'),
      linesAfter: z
        .number()
        .int()
        .min(0)
        .max(MAX_EXPAND_WINDOW_LINES)
        .optional()
        .describe('Number of lines to include after each match (default 5).')
    },
    async ({ paths, terms, linesBefore, linesAfter }) => {
      try {
        const root = getWorkspaceRoot();
        let output = '';
        for (const p of paths) {
          if (estimateTokens(output) >= MAX_EXPAND_RESPONSE_TOKENS) {
            output += RESPONSE_MARKER;
            break;
          }
          const resolved = resolveWithinWorkspace(root, p);
          if (resolved === null) {
            const appended = appendSection(
              output,
              p,
              'Access denied: path is outside the workspace root.'
            );
            output = appended.output;
            if (appended.truncated) break;
            continue;
          }
          const remaining = Math.max(1, MAX_EXPAND_RESPONSE_TOKENS - estimateTokens(output));
          const headerTokens = estimateTokens(`### ${p.slice(0, 512)}\n\`\`\`\n\`\`\`\n\n`);
          const content = extractTermWindows(resolved, terms, {
            linesBefore,
            linesAfter,
            maxTokens: Math.max(1, remaining - headerTokens)
          });
          const appended = appendSection(output, p, content);
          output = appended.output;
          if (appended.truncated) break;
        }

        return {
          content: [
            {
              type: 'text',
              text: output.trim()
            }
          ]
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error extracting windows: ${getErrorMessage(error)}` }],
          isError: true
        };
      }
    }
  );
}
