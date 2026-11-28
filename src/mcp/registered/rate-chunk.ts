import path from 'node:path';
import fs from 'node:fs';
import { DB, getContextOSHome } from '../../core/storage/database.js';

import { z } from 'zod';

import { entityRef, parseRef } from '../../core/workspace/identity.js';

import { FeedbackTracker } from '../../core/feedback/tracker.js';

import { ChunksRepo } from '../../core/storage/chunks-repo.js';

import type { WorkspaceToolContext } from '../workspace-tools.js';
export default function register(c: WorkspaceToolContext): void {
  const {
    response,
    failure,
    server,
    runtime,
    cache,
    choose,
    viewSchema,
    chooseView,
    legacyEnabled
  } = c;
  if (!legacyEnabled) return;
  server.tool(
    'rate_chunk',
    'Rate a chunk in its owning project/worktree. Qualified chunk references are preferred; historical bare IDs resolve against the active or selected view.',
    {
      ...viewSchema,
      chunk_id: z.string(),
      adjustment: z.number().min(-5).max(5),
      reason: z.string().optional()
    },
    async (args) => {
      try {
        const ref = parseRef(args.chunk_id);
        if (ref && ref.kind !== 'chunk')
          throw new Error('Feedback requires a qualified chunk reference.');
        const explicit = args.repo || args.project || args.worktree || args.branch;
        if (ref?.repoId === 'global') {
          if (explicit)
            throw new Error('Global chunks cannot be rated with a project/worktree selector.');
          const globalPath = path.join(getContextOSHome(), 'index.db');
          if (!fs.existsSync(globalPath)) throw new Error('Global index is unavailable.');
          const globalDb = new DB(globalPath);
          try {
            const chunk = new ChunksRepo(globalDb.getInstance()).getByIds([ref.localId])[0];
            if (!chunk || chunk.layer !== 'global')
              throw new Error('Global chunk does not exist in the shared global index.');
            const id = new FeedbackTracker(globalDb).recordFeedback(
              ref.localId,
              args.adjustment,
              args.reason
            );
            cache.clear();
            return {
              ...response('Recorded feedback.'),
              structuredContent: {
                source: { repoId: 'global' },
                ref: entityRef('global', 'feedback', id),
                chunk: args.chunk_id
              }
            };
          } finally {
            globalDb.close();
          }
        }
        const source = ref && !explicit ? choose(ref.repoId) : chooseView(args);
        if (ref && ref.repoId !== source.repoId)
          throw new Error('Chunk belongs to another selected project/worktree.');
        const owner = runtime.get(source);
        await owner.prepareRead();
        const localId = ref?.localId ?? args.chunk_id;
        if (!new ChunksRepo(owner.db.getInstance()).getByIds([localId]).length)
          throw new Error('Chunk does not exist in the selected view.');
        owner.assertReadable();
        const id = new FeedbackTracker(owner.db).recordFeedback(
          localId,
          args.adjustment,
          args.reason
        );
        cache.clear();
        return {
          ...response('Recorded feedback.'),
          structuredContent: {
            source,
            ref: entityRef(source.repoId, 'feedback', id),
            chunk: entityRef(source.repoId, 'chunk', localId)
          }
        };
      } catch (error) {
        return failure(error);
      }
    }
  );
}
