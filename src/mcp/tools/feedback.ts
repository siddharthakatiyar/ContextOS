import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DB } from "../../core/storage/database.js";
import { FeedbackTracker } from "../../core/feedback/tracker.js";

export function registerFeedbackTools(server: McpServer, dbs: DB[]) {
  // Feedback signals are stored in the primary project DB
  const primaryDb = dbs[0];
  const tracker = new FeedbackTracker(primaryDb);

  server.tool(
    "rate_chunk",
    "Provide feedback on a retrieved context chunk. Use this if a chunk was exceptionally useful (+1) or completely irrelevant (-1) to your task. This helps ContextOS learn and improve future retrievals.",
    {
      chunk_id: z.string().describe("The ID of the chunk to rate"),
      adjustment: z.number().describe("The score adjustment: 1 for useful, -1 for irrelevant"),
      reason: z.string().optional().describe("Optional reason for this rating"),
    },
    async ({ chunk_id, adjustment, reason }) => {
      try {
        if (adjustment < -5 || adjustment > 5) {
          throw new Error("Adjustment must be between -5 and 5");
        }
        
        const id = tracker.recordFeedback(chunk_id, adjustment, reason);
        return {
          content: [{ type: "text", text: `Successfully recorded feedback. ID: ${id}` }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error recording feedback: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
