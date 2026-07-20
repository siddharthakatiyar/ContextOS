import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DB } from '../../core/storage/database.js';
import { RelationshipsRepo } from '../../core/storage/relationships-repo.js';
import { ChunksRepo } from '../../core/storage/chunks-repo.js';
import { estimateTokens } from '../../utils/tokens.js';

export function registerGetGraphTools(server: McpServer, db: DB) {
  const relsRepo = new RelationshipsRepo(db.getInstance());
  const chunksRepo = new ChunksRepo(db.getInstance());

  server.tool(
    'ctx_symbol',
    'Retrieve the code for a specific symbol (function, class, etc) and explore its graph neighbors.',
    {
      symbolName: z.string().describe('The exact name of the symbol to retrieve and explore')
    },
    async ({ symbolName }) => {
      try {
        const chunks = chunksRepo.findBySymbolName(symbolName);
        const relationships = relsRepo.findRelated(symbolName);

        if (chunks.length === 0 && relationships.length === 0) {
          return {
            content: [
              { type: 'text', text: `No code or relationships found for symbol: ${symbolName}` }
            ]
          };
        }

        let output = `## Symbol: \`${symbolName}\`\n\n`;

        // Render chunks
        if (chunks.length > 0) {
          // first chunk full, rest as stubs
          const first = chunks[0];
          output += `### ${first.symbolKind || 'Symbol'} in \`${first.sourceFile}\`\n`;
          output += `\`\`\`${first.language || ''}\n${first.content}\n\`\`\`\n\n`;

          if (chunks.length > 1) {
            output += `### Also\n`;
            for (let i = 1; i < chunks.length; i++) {
              const c = chunks[i];
              const loc =
                c.startLine != null && c.endLine != null
                  ? `${c.sourceFile}:${c.startLine}-${c.endLine}`
                  : c.sourceFile;
              output += `- \`${c.symbolKind || 'Symbol'} ${c.symbolName}\` in \`${loc}\`\n`;
            }
            output += `\n`;
          }
        }

        // Render relationships (max 20)
        if (relationships.length > 0) {
          const limitedRels = relationships.slice(0, 20);
          output += `### Graph Neighbors\n`;
          for (const rel of limitedRels) {
            const isSource = rel.source.toLowerCase() === symbolName.toLowerCase();
            const other = isSource ? rel.target : rel.source;
            const direction = isSource ? '->' : '<-';
            output += `- \`${symbolName}\` ${direction} [${rel.relationshipType}] ${direction} \`${other}\` (weight: ${rel.weight})\n`;
          }
          if (relationships.length > 20) {
            output += `- ... ${relationships.length - 20} more relationships omitted.\n`;
          }
        }

        // 1000-token cap enforcement (if we exceeded, we might want to trim, but the first chunk alone could be big. We just return it, the chunker already caps individual chunks to maxChunkTokens)
        // If the total output > 1000, we trim it? Wait, plan says "with fitContentToBudget caps: 1000 default".
        let tokens = estimateTokens(output);
        if (tokens > 1000) {
          // It's mostly the first chunk that is big
          const lines = output.split('\n');
          const trimmed =
            lines.slice(0, 150).join('\n') + `\n\n... [truncated to fit 1000-token cap] ...`;
          output = trimmed;
        }

        return { content: [{ type: 'text', text: output }] };
      } catch (error: any) {
        return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
      }
    }
  );
}

export function registerLegacyGetGraphTools(server: McpServer, db: DB) {
  const relsRepo = new RelationshipsRepo(db.getInstance());
  const chunksRepo = new ChunksRepo(db.getInstance());

  server.tool(
    'get_neighbors',
    'CRITICAL: You MUST use this tool to explore relationships between entities instead of searching files manually. Explore the code graph by finding all entities immediately related to a given entity (like a class, function, or file). Returns the graph edges and the source context for each connection.',
    {
      entity: z.string().describe("The name of the entity to explore (e.g. 'SessionManager', 'DB')")
    },
    async ({ entity }) => {
      try {
        const relationships = relsRepo.findRelated(entity);
        if (relationships.length === 0) {
          return {
            content: [{ type: 'text', text: `No relationships found for entity: ${entity}` }]
          };
        }

        const chunkIds = [...new Set(relationships.map((r) => r.sourceChunkId))] as string[];
        const chunks = chunksRepo.getByIds(chunkIds);
        const chunkMap = new Map(chunks.map((c) => [c.id, c]));

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
          content: [{ type: 'text', text: output }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error fetching neighbors: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  server.tool(
    'get_symbol',
    'CRITICAL: You MUST use this tool to look up symbols instead of grepping or using native symbol search. Retrieve the exact code chunk and file location for a specific code symbol (function, class, struct, etc).',
    {
      symbolName: z.string().describe('The exact name of the symbol to retrieve')
    },
    async ({ symbolName }) => {
      try {
        const chunks = chunksRepo.findBySymbolName(symbolName);
        if (chunks.length === 0) {
          return {
            content: [{ type: 'text', text: `No code chunks found for symbol: ${symbolName}` }]
          };
        }

        let output = `## Symbol: \`${symbolName}\`\n\n`;
        for (const chunk of chunks) {
          output += `### ${chunk.symbolKind || 'Symbol'} in \`${chunk.sourceFile}\`\n`;
          output += `\`\`\`${chunk.language || ''}\n${chunk.content}\n\`\`\`\n\n`;
        }

        return {
          content: [{ type: 'text', text: output }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error fetching symbol: ${error.message}` }],
          isError: true
        };
      }
    }
  );
}
