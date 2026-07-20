import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { DB } from '../../core/storage/database.js';
import { KnowledgeStore } from '../../core/memory/knowledge-store.js';
import { SessionStore } from '../../core/session/session-store.js';

export function registerKnowledgeTools(server: McpServer, dbs: DB[]) {
  const primaryDb = dbs[0];
  const store = new KnowledgeStore(primaryDb);
  const sessionStore = new SessionStore(primaryDb);

  server.tool(
    'ctx_remember',
    'Save important notes or context to memory. Can be session-specific (type=session_note) or cross-session (type=cross_session_fact). Use type=forget_fact to remove a fact.',
    {
      type: z
        .enum(['session_note', 'cross_session_fact', 'forget_fact'])
        .describe('Type of memory operation'),
      content: z.string().describe('The note, fact, or fact ID to operate on'),
      category: z.string().optional().describe('Optional category for cross_session_fact')
    },
    async ({ type, content, category }) => {
      try {
        if (type === 'forget_fact') {
          const success = store.forgetFact(content);
          if (success) {
            return { content: [{ type: 'text', text: `Successfully forgot fact ${content}` }] };
          }
          return { content: [{ type: 'text', text: `Fact ${content} not found.` }], isError: true };
        } else if (type === 'cross_session_fact') {
          const id = store.learnFact(content, category || 'general');
          return { content: [{ type: 'text', text: `Successfully learned fact. ID: ${id}` }] };
        } else {
          let session = sessionStore.getLatestSession();
          if (!session) session = sessionStore.createSession(process.cwd());
          sessionStore.addEvent({
            sessionId: session.id,
            eventType: 'system_response',
            content: content,
            relatedFiles: null
          });
          return {
            content: [{ type: 'text', text: `Successfully saved context note to session memory.` }]
          };
        }
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error managing memory: ${error.message}` }],
          isError: true
        };
      }
    }
  );
}

export function registerLegacyKnowledgeTools(server: McpServer, dbs: DB[]) {
  const primaryDb = dbs[0];
  const store = new KnowledgeStore(primaryDb);

  server.tool(
    'learn_fact',
    'Store a cross-session memory fact. Use this to remember user preferences, architectural decisions, or recurring bugs across different chat sessions.',
    {
      fact: z.string().describe('The fact to remember'),
      category: z
        .string()
        .optional()
        .default('general')
        .describe('An optional category for the fact')
    },
    async ({ fact, category }) => {
      try {
        const id = store.learnFact(fact, category);
        return {
          content: [{ type: 'text', text: `Successfully learned fact. ID: ${id}` }]
        };
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error learning fact: ${error.message}` }],
          isError: true
        };
      }
    }
  );

  server.tool(
    'forget_fact',
    'Remove a previously learned cross-session memory fact using its ID.',
    {
      id: z.string().describe('The ID of the fact to forget')
    },
    async ({ id }) => {
      try {
        const success = store.forgetFact(id);
        if (success) {
          return {
            content: [{ type: 'text', text: `Successfully forgot fact ${id}` }]
          };
        } else {
          return {
            content: [{ type: 'text', text: `Fact ${id} not found.` }],
            isError: true
          };
        }
      } catch (error: any) {
        return {
          content: [{ type: 'text', text: `Error forgetting fact: ${error.message}` }],
          isError: true
        };
      }
    }
  );
}
