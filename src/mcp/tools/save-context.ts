import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DB } from '../../core/storage/database.js';
import { SessionStore } from '../../core/session/session-store.js';
import { getErrorMessage } from '../../utils/errors.js';

export function registerSaveContextTool(server: McpServer, db: DB) {
  const sessionStore = new SessionStore(db);
  server.tool(
    'save_context',
    'Save important notes or context to the current session memory. Use this to remember user preferences, important decisions, or architectural facts that should persist across subsequent queries in this session.',
    {
      note: z.string().describe('The important context or note to save'),
      related_files: z
        .string()
        .optional()
        .describe('Comma separated list of related file paths, if any')
    },
    async ({ note, related_files }) => {
      try {
        let session = sessionStore.getLatestSession();
        if (!session) {
          session = sessionStore.createSession(process.cwd());
        }

        sessionStore.addEvent({
          sessionId: session.id,
          eventType: 'system_response', // Treat saved notes as system responses/context
          content: note,
          relatedFiles: related_files || null
        });

        return {
          content: [
            {
              type: 'text',
              text: `Successfully saved context note to session memory.`
            }
          ]
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: `Error saving context: ${getErrorMessage(error)}` }],
          isError: true
        };
      }
    }
  );
}
