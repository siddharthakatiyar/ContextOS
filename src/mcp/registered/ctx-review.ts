import { z } from 'zod';
import {
  listKnowledge,
  setKnowledgeStatus,
  deleteKnowledge,
  promoteKnowledge
} from '../../core/knowledge/review.js';
import type { WorkspaceKnowledgeContext } from '../tools/knowledge.js';
export default function register(c: WorkspaceKnowledgeContext): void {
  c.server.tool(
    'ctx_review',
    'Review saved knowledge, including task-private items. Agent mutations require CONTEXTOS_ALLOW_AGENT_REVIEW=1.',
    {
      ...c.selectors,
      ...c.verbose,
      action: z.enum(['list', 'accept', 'reject', 'show', 'promote']),
      ids: z.array(z.string()).optional(),
      id: z.string().optional(),
      task_id: z.string().optional(),
      author: z.string().optional(),
      status: z.enum(['proposed', 'stale', 'verified']).optional(),
      all_proposed: z.boolean().optional(),
      to: z.enum(['project', 'group']).optional(),
      accept: z.boolean().optional(),
      limit: z.number().int().min(1).max(500).default(20),
      offset: z.number().int().nonnegative().default(0)
    },
    c.wrap((args) => {
      const action = args.action as string;
      if (!['list', 'show'].includes(action) && process.env.CONTEXTOS_ALLOW_AGENT_REVIEW !== '1')
        throw new Error(
          'Agent review mutations are disabled. Set CONTEXTOS_ALLOW_AGENT_REVIEW=1 to allow accept, reject or promote.'
        );
      const options = {
        scope: c.scopeFor(args),
        reviewer: c.server.server?.getClientVersion()?.name ?? 'mcp'
      };
      const records = listKnowledge({
        ...options,
        taskId: args.task_id as string | undefined,
        author: args.author as string | undefined,
        status: args.status as 'proposed' | 'stale' | 'verified' | undefined
      });
      if (action === 'list') {
        const offset = args.offset as number,
          limit = args.limit as number;
        return {
          total: records.length,
          records: records.slice(offset, offset + limit).map((r) =>
            args.verbose
              ? r
              : {
                  id: r.id,
                  kind: r.kind,
                  status: r.status,
                  taskId: r.taskId,
                  author: r.author,
                  namespace: r.namespace,
                  expiresAt: r.expiresAt,
                  content: r.content?.slice(0, 240)
                }
          ),
          next_offset: offset + limit < records.length ? offset + limit : null
        };
      }
      if (action === 'show') {
        if (!args.id) throw new Error('show requires id.');
        const record = records.find((r) => r.id === args.id);
        if (!record) throw new Error('Knowledge not found in selected scope.');
        return { record };
      }
      const explicit = args.ids as string[] | undefined;
      if (Number(!!explicit?.length) + Number(!!args.task_id) + Number(!!args.all_proposed) !== 1)
        throw new Error('Select exactly one of ids, task_id or all_proposed.');
      if (args.all_proposed && action !== 'accept')
        throw new Error('all_proposed is only valid for accept.');
      const ids = explicit?.length
        ? explicit
        : records.filter((r) => action !== 'accept' || r.status === 'proposed').map((r) => r.id);
      let output;
      if (action === 'accept') {
        if (listKnowledge(options).some((r) => ids.includes(r.id) && r.status !== 'proposed'))
          throw new Error('Accept requires proposed status.');
        output = { records: setKnowledgeStatus(ids, 'verified', options) };
      } else if (action === 'reject')
        output = deleteKnowledge(ids, { ...options, operation: 'reject' });
      else {
        if (!args.to) throw new Error('promote requires to.');
        output = {
          records: promoteKnowledge(ids, args.to as 'project' | 'group', {
            ...options,
            accept: args.accept as boolean | undefined
          })
        };
      }
      c.context.clearCache();
      return args.verbose
        ? output
        : { count: output.records.length, ids: output.records.map((r) => r.id) };
    }, true)
  );
}
