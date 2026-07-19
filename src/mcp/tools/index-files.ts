import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DB } from "../../core/storage/database.js";
import { Indexer } from "../../core/indexer/index.js";
import path from "path";
import { globalSentRegistry } from "../../core/session/sent-registry.js";

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
    async ({ path: filePath, layer, workspaceName }) => {
      try {
        if (filePath.includes('../') || filePath.includes('..\\')) {
          return {
            content: [{ type: "text", text: "Directory traversal is not allowed in path." }],
            isError: true,
          };
        }
        
        const root = process.env.CONTEXTOS_REPO_ROOT || process.cwd();
        const resolvedPath = path.resolve(root, filePath);
        if (!resolvedPath.startsWith(path.resolve(root))) {
          return {
            content: [{ type: "text", text: `Path must be within workspace root (${root}).` }],
            isError: true,
          };
        }

        const stats = await indexer.indexFile(resolvedPath, layer as any, workspaceName);
        globalSentRegistry.invalidate();
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
