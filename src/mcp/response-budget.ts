import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { encode } from 'gpt-tokenizer';

/** Count the complete tool result, including structured data and its token counter. */
export function responseTokens(result: CallToolResult): number {
  return encode(JSON.stringify(result)).length;
}

/** Bound both representations together. Never return unbudgeted scope/catalog metadata. */
export function boundResponse(result: CallToolResult, budget: number): void {
  const data = (result.structuredContent ??= {});
  const recount = () => {
    data.tokens = 0;
    for (let i = 0; i < 5; i++) {
      const count = responseTokens(result);
      if (data.tokens === count) return count;
      data.tokens = count;
    }
    return responseTokens(result);
  };
  if (recount() <= budget) return;
  data.truncated = true;
  for (const key of [
    'explanation',
    'compilation',
    'omittedRepositories',
    'sources',
    'scope',
    'linkSuggestions',
    'learnedLinks',
    'knowledgeLinks',
    'unavailableSources'
  ]) {
    if (recount() <= budget) return;
    delete data[key];
  }
  // Preserve the first, highest-ranked hits when possible.
  const chunks = data.chunks as unknown[] | undefined;
  while (chunks?.length && recount() > budget) chunks.pop();
  const text = result.content.find((item) => item.type === 'text');
  if (text?.type === 'text' && recount() > budget) {
    const original = text.text;
    let low = 0,
      high = original.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      text.text = original.slice(0, mid);
      if (recount() <= budget) low = mid;
      else high = mid - 1;
    }
    text.text = original.slice(0, low);
  }
  if (recount() > budget) {
    // Extremely small requested budgets cannot hold the normal envelope.
    result.content = [];
    for (const key of Object.keys(data)) if (key !== 'tokens') delete data[key];
    if (recount() > budget) delete result.structuredContent;
  }
  recount();
}
