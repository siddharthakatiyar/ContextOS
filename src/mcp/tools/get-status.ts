import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DB } from "../../core/storage/database.js";
import { ChunksRepo } from "../../core/storage/chunks-repo.js";

export function registerGetStatusTool(server: McpServer, db: DB) {
  const chunksRepo = new ChunksRepo(db.getInstance());

  server.tool(
    "contextos_status",
    "Show the current status of the ContextOS index — chunk counts, layer breakdown, and last index time.",
    {},
    async () => {
      try {
        const stats = chunksRepo.getStats();
        
        let output = `## ContextOS Index Status\n\n`;
        output += `- **Total Chunks**: ${stats.totalChunks}\n`;
        output += `- **Total Tokens**: ${stats.totalTokens}\n\n`;
        output += `### By Layer\n`;
        output += `- Session: ${stats.byLayer.session}\n`;
        output += `- Repo: ${stats.byLayer.repo}\n`;
        output += `- Workspace: ${stats.byLayer.workspace}\n`;
        output += `- Global: ${stats.byLayer.global}\n`;

        return {
          content: [
            {
              type: "text",
              text: output,
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error getting status: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
