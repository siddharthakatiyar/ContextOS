import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DB } from "../../core/storage/database.js";
import { ChunksRepo } from "../../core/storage/chunks-repo.js";
import { loadConfig } from "../../config/index.js";

export function registerListTopicsTool(server: McpServer, db: DB) {
  server.tool(
    "ctx_list_topics",
    "List available context topics or rules in the workspace. Returns a list of document titles and summaries.",
    {},
    async () => {
      try {
        const repo = new ChunksRepo(db.getInstance());
        // Find markdown files (or chunks) that have a title or frontmatter
        const stmt = db.getInstance().prepare(`
          SELECT DISTINCT source_file, section_title, summary
          FROM chunks
          WHERE file_type = 'md' AND section_depth = 1 AND section_title IS NOT NULL
          LIMIT ${loadConfig().ftsLimit}
        `);
        const rows = stmt.all() as any[];

        if (rows.length === 0) {
          return {
            content: [{ type: "text", text: "No explicit context topics found. You can try general searching." }],
          };
        }

        const topics = rows.map(r => `- Topic: "${r.section_title}" (File: ${r.source_file})\n  Summary: ${r.summary || 'No summary available'}`).join('\n\n');

        return {
          content: [{ type: "text", text: `Available Context Topics:\n\n${topics}` }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error fetching topics: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
