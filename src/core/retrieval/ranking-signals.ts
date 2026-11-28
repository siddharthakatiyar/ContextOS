import type { ScoredChunk } from './types.js';

/** JSON/config is supporting material unless explicitly requested by kind or filename. */
export function rawChunkMultiplier(prompt: string, chunk: ScoredChunk): number {
  const file = chunk.relativePath ?? chunk.sourceFile;
  if (
    !/(?:\.json[cl]?|\.ya?ml|\.toml|\.ini|\.env|\.lock)$|(?:^|\/)\.?[^/]*config[^/]*$|lock\.yaml$/i.test(
      file
    )
  )
    return 1;
  const name = file.split('/').at(-1)!.toLowerCase();
  return /\b(config(?:uration)?|json|yaml|toml|lockfile|settings|environment)\b/i.test(prompt) ||
    prompt.toLowerCase().includes(name)
    ? 1
    : 0.2;
}
