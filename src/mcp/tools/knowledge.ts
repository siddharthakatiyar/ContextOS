import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DB } from "../../core/storage/database.js";
import { KnowledgeStore } from "../../core/memory/knowledge-store.js";

export function registerKnowledgeTools(server: McpServer, dbs: DB[]) {
  // Knowledge facts are stored in the primary project DB
  const primaryDb = dbs[0];
  const store = new KnowledgeStore(primaryDb);

  server.tool(
    "learn_fact",
    "Store a cross-session memory fact. Use this to remember user preferences, architectural decisions, or recurring bugs across different chat sessions. Examples: 'The user prefers functional React components', 'The auth service uses JWT'.",
    {
      fact: z.string().describe("The fact to remember"),
      category: z.string().optional().default("general").describe("An optional category for the fact (e.g., 'preferences', 'architecture', 'bugs')"),
    },
    async ({ fact, category }) => {
      try {
        const id = store.learnFact(fact, category);
        return {
          content: [{ type: "text", text: `Successfully learned fact. ID: ${id}` }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error learning fact: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "forget_fact",
    "Remove a previously learned cross-session memory fact using its ID.",
    {
      id: z.string().describe("The ID of the fact to forget"),
    },
    async ({ id }) => {
      try {
        const success = store.forgetFact(id);
        if (success) {
          return {
            content: [{ type: "text", text: `Successfully forgot fact ${id}` }],
          };
        } else {
          return {
            content: [{ type: "text", text: `Fact ${id} not found.` }],
            isError: true,
          };
        }
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error forgetting fact: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
