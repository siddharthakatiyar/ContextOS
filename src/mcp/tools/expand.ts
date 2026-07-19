import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { extractTermWindows } from "../../core/expand/window-extractor.js";
import { DB } from "../../core/storage/database.js";

export function registerExpandTool(server: McpServer, dbs: DB[]) {
  server.tool(
    "ctx_expand",
    "Extract targeted windows of code around specific terms from files. Use this when get_context returns stubs and you need to peek at specific implementations without loading the entire file.",
    {
      paths: z.array(z.string()).describe("List of file paths to extract from."),
      terms: z.array(z.string()).describe("List of terms (symbols, identifiers, keywords) to search for in these files."),
      linesBefore: z.number().optional().describe("Number of lines to include before each match (default 5)."),
      linesAfter: z.number().optional().describe("Number of lines to include after each match (default 5)."),
    },
    async ({ paths, terms, linesBefore, linesAfter }) => {
      try {
        let output = "";
        for (const path of paths) {
          const content = extractTermWindows(path, terms, { linesBefore, linesAfter });
          output += `### ${path}\n\`\`\`\n${content}\n\`\`\`\n\n`;
        }

        return {
          content: [
            {
              type: "text",
              text: output.trim(),
            },
          ],
        };
      } catch (error: any) {
        return {
          content: [{ type: "text", text: `Error extracting windows: ${error.message}` }],
          isError: true,
        };
      }
    }
  );
}
