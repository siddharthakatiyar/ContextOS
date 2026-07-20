import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DB } from '../../core/storage/database.js';
import { ChunksRepo } from '../../core/storage/chunks-repo.js';
import { loadConfig } from '../../config/index.js';

export function registerListTopicsTool(server: McpServer, db: DB) {
  server.tool(
    'ctx_topics',
    'List available context topics/rules, or read a specific topic by providing its title. Do not rely on built-in search for topics.',
    {
      title: z
        .string()
        .optional()
        .describe('If provided, reads the full content of the topic. If omitted, lists all topics.')
    },
    async ({ title }) => {
      try {
        if (title) {
          const stmt = db.getInstance().prepare(`
            SELECT content, source_file
            FROM chunks
            WHERE section_title = ?
            ORDER BY section_depth ASC
            LIMIT 10
          `);
          const rows = stmt.all(title) as any[];

          if (rows.length === 0) {
            return {
              content: [{ type: 'text', text: `Topic "${title}" not found.` }],
              isError: true
            };
          }
          const contents = rows
            .map((r) => `--- From ${r.source_file} ---\n${r.content}`)
            .join('\n\n');
          return { content: [{ type: 'text', text: contents }] };
        } else {
          const stmt = db.getInstance().prepare(`
            SELECT DISTINCT source_file, section_title, summary
            FROM chunks
            WHERE file_type = 'md' AND section_depth = 1 AND section_title IS NOT NULL
            LIMIT ${loadConfig().ftsLimit}
          `);
          const rows = stmt.all() as any[];

          if (rows.length === 0) {
            return {
              content: [
                {
                  type: 'text',
                  text: 'No explicit context topics found. You can try general searching.'
                }
              ]
            };
          }

          const topics = rows
            .map(
              (r) =>
                `- Topic: "${r.section_title}" (File: ${r.source_file})\n  Summary: ${r.summary || 'No summary available'}`
            )
            .join('\n\n');
          return {
            content: [{ type: 'text', text: `Available Context Topics:\n\n${topics}` }]
          };
        }
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error: ${error.message}` }],
          isError: true
        };
      }
    }
  );
}

export function registerLegacyListTopicsTool(server: McpServer, db: DB) {
  server.tool(
    'ctx_list_topics',
    'CRITICAL: You MUST use this tool to list available context topics or rules in the workspace. Returns a list of document titles and summaries. Do not rely on built-in search for topics.',
    {},
    async () => {
      try {
        const stmt = db.getInstance().prepare(`
          SELECT DISTINCT source_file, section_title, summary
          FROM chunks
          WHERE file_type = 'md' AND section_depth = 1 AND section_title IS NOT NULL
          LIMIT ${loadConfig().ftsLimit}
        `);
        const rows = stmt.all() as any[];

        if (rows.length === 0) {
          return {
            content: [
              {
                type: 'text',
                text: 'No explicit context topics found. You can try general searching.'
              }
            ]
          };
        }

        const topics = rows
          .map(
            (r) =>
              `- Topic: "${r.section_title}" (File: ${r.source_file})\n  Summary: ${r.summary || 'No summary available'}`
          )
          .join('\n\n');

        return {
          content: [{ type: 'text', text: `Available Context Topics:\n\n${topics}` }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error fetching topics: ${error.message}` }],
          isError: true
        };
      }
    }
  );
}
