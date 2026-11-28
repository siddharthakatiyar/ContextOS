import { z } from 'zod';
/** Plumbing only: no review, retention, or visibility policy. */
export const knowledgeWriteSchema = {
  author: z.string().optional(),
  task_id: z.string().optional(),
  model: z.string().optional(),
  status: z.enum(['proposed', 'verified', 'stale']).optional(),
  namespace: z.string().optional(),
  expires_at: z.number().int().nullable().optional()
};
