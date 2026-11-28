import fs from 'node:fs';
import path from 'node:path';
import { getContextOSHome } from '../storage/database.js';
import { preparePrivateStateFile } from '../../utils/secure-state.js';
import {
  resolveKnowledgeWriteContext,
  type KnowledgeWriteContext,
  type KnowledgeMetadata
} from './write-context.js';

/** Record provenance for removed knowledge and temporary notes, which have no metadata row.
 * Deletion intent is appended before durable removal. This excludes note/deleted content.
 */
export function recordKnowledgeOperation(
  operation:
    | 'remember_session'
    | 'forget'
    | 'unlink'
    | 'accept'
    | 'reject'
    | 'expire'
    | 'promote'
    | 'rollback',
  id: string,
  context: KnowledgeWriteContext = {},
  home = getContextOSHome()
): void {
  const file = preparePrivateStateFile(path.join(home, 'knowledge-audit.jsonl'));
  fs.appendFileSync(
    file,
    JSON.stringify({
      operation,
      id,
      at: Date.now(),
      ...(['accept', 'reject', 'promote', 'rollback'].includes(operation)
        ? { reviewer: resolveKnowledgeWriteContext(context).author }
        : {}),
      ...resolveKnowledgeWriteContext(context)
    }) + '\n',
    { mode: 0o600 }
  );
}

/** Session provenance lives in the existing audit sidecar, without schema changes. */
export function sessionKnowledgeMetadata(
  home = getContextOSHome()
): Map<string, KnowledgeMetadata & { at: number }> {
  const file = path.join(home, 'knowledge-audit.jsonl');
  const result = new Map<string, KnowledgeMetadata & { at: number }>();
  if (!fs.existsSync(file)) return result;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.operation === 'remember_session') result.set(row.id, row);
    else if (row.operation === 'accept' && result.has(row.id))
      result.set(row.id, { ...result.get(row.id)!, status: 'verified', verifiedAt: row.at });
  }
  return result;
}
