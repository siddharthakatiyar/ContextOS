import fs from 'node:fs';
import path from 'node:path';
import { getContextOSHome } from '../storage/database.js';
import { preparePrivateStateFile } from '../../utils/secure-state.js';
import { resolveKnowledgeWriteContext, type KnowledgeWriteContext } from './write-context.js';

/** Record provenance for removed knowledge and temporary notes, which have no metadata row.
 * Deletion intent is appended before durable removal. This excludes note/deleted content.
 */
export function recordKnowledgeOperation(
  operation: 'remember_session' | 'forget' | 'unlink',
  id: string,
  context: KnowledgeWriteContext = {},
  home = getContextOSHome()
): void {
  const file = preparePrivateStateFile(path.join(home, 'knowledge-audit.jsonl'));
  fs.appendFileSync(
    file,
    JSON.stringify({ operation, id, at: Date.now(), ...resolveKnowledgeWriteContext(context) }) +
      '\n',
    { mode: 0o600 }
  );
}
