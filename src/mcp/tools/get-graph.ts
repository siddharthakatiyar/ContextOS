import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DB } from "../../core/storage/database.js";
import { RelationshipsRepo } from "../../core/storage/relationships-repo.js";
import { ChunksRepo } from "../../core/storage/chunks-repo.js";

export function registerGetGraphTools(server: McpServer, db: DB) {
  const relsRepo = new RelationshipsRepo(db.getInstance());
  const chunksRepo = new ChunksRepo(db.getInstance());

  server.tool(
    "get_neighbors",
    "Explore the code graph by finding all entities immediately related to a given entity (like a class, function, or file). Returns the graph edges and the source context for each connection.",
    {
      entity: z.string().describe("The name of the entity to explore (e.g. 'SessionManager', 'DB')"),
    },
    async ({ entity }) => {
      try {
        const relationships = relsRepo.findRelated(entity);
        if (relationships.length === 0) {
          return {
            content: [{ type: "text", text: `No relationships found for entity: ${entity}` }],
          };
        }

        // Get the chunks that originated these relationships
        const chunkIds = [...new Set(relationships.map(r => r.sourceChunkId))] as string[];
        const chunks = chunksRepo.getByIds(chunkIds);
        const chunkMap = new Map(chunks.map(c => [c.id, c]));

        let output = `## Graph Neighbors for \`${entity}\`\n\n`;

        for (const rel of relationships) {
          const isSource = rel.source.toLowerCase() === entity.toLowerCase();
          const other = isSource ? rel.target : rel.source;
          const direction = isSource ? '->' : '<-';
          
          output += `- \`${entity}\` ${direction} [${rel.relationshipType}] ${direction} \`${other}\` (weight: ${rel.weight})\n`;
          
          const chunk = chunkMap.get(rel.sourceChunkId);
          if (chunk) {
            output += `  * Source: \`${chunk.sourceFile}\`\n`;
            if (chunk.symbolName) {
              output += `  * Found in: \`${chunk.symbolKind} ${chunk.symbolName}\`\n`;
            }
          }
        }

        return {
          content: [{ type: "text", text: output }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error fetching neighbors: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_symbol",
    "Retrieve the exact code chunk and file location for a specific code symbol (function, class, struct, etc).",
    {
      symbolName: z.string().describe("The exact name of the symbol to retrieve"),
    },
    async ({ symbolName }) => {
      try {
        const chunks = chunksRepo.findBySymbolName(symbolName);
        if (chunks.length === 0) {
          return {
            content: [{ type: "text", text: `No code chunks found for symbol: ${symbolName}` }],
          };
        }

        let output = `## Symbol: \`${symbolName}\`\n\n`;
        for (const chunk of chunks) {
          output += `### ${chunk.symbolKind || 'Symbol'} in \`${chunk.sourceFile}\`\n`;
          output += `\`\`\`${chunk.language || ''}\n${chunk.content}\n\`\`\`\n\n`;
        }

        return {
          content: [{ type: "text", text: output }],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error fetching symbol: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
