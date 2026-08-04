import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DB } from '../../core/storage/database.js';
import { getErrorMessage } from '../../utils/errors.js';

interface TopicContentRow {
  content: string;
  source_file: string;
}

export function registerLegacyReadTopicTool(server: McpServer, db: DB) {
  server.tool(
    'ctx_read_topic',
    'CRITICAL: You MUST use this tool to read rule documents or context topics instead of reading files directly. Read the full content of a specific context topic or rule document by its exact title.',
    {
      title: z.string().describe("The exact title of the topic to read (e.g. 'PR Rules')")
    },
    async ({ title }) => {
      try {
        const stmt = db.getInstance().prepare(`
          SELECT content, source_file
          FROM chunks
          WHERE section_title = ?
          ORDER BY section_depth ASC
          LIMIT 10
        `);
        const rows = stmt.all(title) as TopicContentRow[];

        if (rows.length === 0) {
          return {
            content: [{ type: 'text', text: `Topic "${title}" not found.` }],
            isError: true
          };
        }

        const contents = rows
          .map((r) => `--- From ${r.source_file} ---\n${r.content}`)
          .join('\n\n');

        return {
          content: [{ type: 'text', text: contents }]
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error reading topic: ${getErrorMessage(error)}` }],
          isError: true
        };
      }
    }
  );
}
