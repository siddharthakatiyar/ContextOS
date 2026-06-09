import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DB } from "../../core/storage/database.js";
import { Indexer } from "../../core/indexer/index.js";

export function registerIndexFilesTool(server: McpServer, db: DB) {
  const indexer = new Indexer(db);

  server.tool(
    "reindex_context",
    "Re-index context files when documentation has been updated. Run this after modifying any .contextos/ files, CLAUDE.md, or engineering documentation.",
    {
      path: z.string().describe("Specific file to re-index. Must be an absolute path."),
      layer: z.enum(["global", "workspace", "repo", "session"]).describe("The layer this file belongs to."),
      workspaceName: z.string().optional().describe("Workspace name if layer is workspace."),
    },
    async ({ path, layer, workspaceName }) => {
      try {
        const stats = await indexer.indexFile(path, layer as any, workspaceName);
        return {
          content: [{
            type: "text",
            text: `Re-indexed: ${stats.filesProcessed} files, ${stats.chunksCreated} chunks, ${stats.relationshipsFound} relationships. Time: ${stats.durationMs}ms.`,
          }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error indexing file: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
