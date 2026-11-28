import { compactKnowledgeMetadata, type KnowledgeStatus } from './write-context.js';

interface FactPresentation {
  id: string;
  fact: string;
  confidence: number;
  author?: string | null;
  task_id?: string | null;
  status?: KnowledgeStatus;
  namespace?: string;
  expires_at?: number | null;
}
function metadata(fact?: FactPresentation) {
  return compactKnowledgeMetadata({
    author: fact?.author ?? undefined,
    taskId: fact?.task_id ?? undefined,
    namespace: fact?.namespace,
    expiresAt: fact?.expires_at,
    status: fact?.status
  });
}

/** Keep state visible in text-only clients and proposals behind verified memories. */
export function prepareFactForContext<T extends FactPresentation>(fact: T): T {
  const fields = metadata(fact);
  return {
    ...fact,
    fact: fact.fact + (Object.keys(fields).length ? '\nKnowledge: ' + JSON.stringify(fields) : ''),
    confidence:
      fact.status && fact.status !== 'verified' ? Math.min(fact.confidence, 0.6) : fact.confidence
  };
}

export function applyFactMetadata<T extends { id: string; score: number }>(
  chunk: T,
  facts: FactPresentation[]
) {
  const fact = facts.find((f) => f.id === chunk.id);
  return {
    ...chunk,
    ...metadata(fact),
    score: chunk.score * (fact?.status === 'proposed' ? 0.1 : fact?.status === 'stale' ? 0.05 : 1)
  };
}
