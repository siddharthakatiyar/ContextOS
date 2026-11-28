import { encode, decode } from 'gpt-tokenizer';
import { compile, type CompiledContext, type CompilerOptions } from '../compiler/index.js';
import { estimateTokens } from '../../utils/tokens.js';
import type { RetrievalResult } from './types.js';

const xml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Reserve a bounded leading section independently of the code compiler's primary selection. */
export function compileRankedContext(
  result: RetrievalResult,
  opts: CompilerOptions
): CompiledContext {
  const saved = result.chunks
    .filter((c) => c.sourceFile === 'memory.fact' && c.sectionTitle?.startsWith('verified '))
    .slice(0, 3);
  if (!saved.length) return compile(result, opts);
  const isXml = opts.outputFormat === 'xml';
  const sectionBudget = Math.min(400, Math.floor(opts.maxTokens * 0.6));
  let section = '';
  const included: { id: string; representation: 'body' | 'excerpt' }[] = [];
  for (const chunk of saved) {
    const render = (body: string) =>
      isXml
        ? `<knowledge status="verified" repo="${xml(chunk.repoName ?? '')}">${xml(body)}</knowledge>\n`
        : `- **${chunk.repoName ?? 'Knowledge'}**: ${body.replace(/\n/g, ' ')}\n`;
    let body = chunk.content;
    if (estimateTokens(section + render(body)) > sectionBudget) {
      if (included.length) break;
      const tokens = encode(body);
      let low = 0,
        high = tokens.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (estimateTokens(render(decode(tokens.slice(0, mid)) + '…')) <= sectionBudget) low = mid;
        else high = mid - 1;
      }
      if (!low) return compile(result, opts);
      body = decode(tokens.slice(0, low)) + '…';
    }
    section += render(body);
    included.push({ id: chunk.id, representation: body === chunk.content ? 'body' : 'excerpt' });
  }
  const selected = new Set(included.map((c) => c.id));
  const remaining = { ...result, chunks: result.chunks.filter((c) => !selected.has(c.id)) };
  const prefix = isXml ? `<contextos_context>\n${section}` : `### Saved knowledge\n${section}\n`;
  const suffix = isXml ? '</contextos_context>\n' : '';
  let rawBudget = Math.max(0, opts.maxTokens - estimateTokens(prefix + suffix) - 8);
  const compileRaw = (budget: number) => {
    const compiled = compile(remaining, {
      ...opts,
      maxTokens: budget,
      maxExactTokens: Math.max(1, budget)
    });
    if (budget === 0) {
      compiled.output = '';
      compiled.tokenCount = 0;
      if (compiled.diagnostics) compiled.diagnostics.includedChunks = [];
    }
    return compiled;
  };
  let raw = compileRaw(rawBudget);
  const combine = () =>
    prefix +
    (isXml
      ? raw.output
          .replace(/^<contextos_context>\n?/, '')
          .replace(/<\/contextos_context>\s*$/, '')
          .replace(/^<contextos_context\s*\/>\s*$/, '')
      : raw.output) +
    suffix;
  let output = combine();
  while (estimateTokens(output) > opts.maxTokens && rawBudget > 0) {
    rawBudget = Math.max(0, rawBudget - Math.max(8, estimateTokens(output) - opts.maxTokens));
    raw = compileRaw(rawBudget);
    output = combine();
  }
  if (raw.diagnostics) {
    raw.diagnostics.includedChunks.unshift(...included);
    const ids = new Set(raw.diagnostics.includedChunks.map((c) => c.id));
    raw.diagnostics.omittedChunkIds = result.chunks.filter((c) => !ids.has(c.id)).map((c) => c.id);
    raw.diagnostics.configuredMaxTokens = opts.maxTokens;
    raw.diagnostics.effectiveMaxTokens = opts.maxTokens;
  }
  return { ...raw, output, tokenCount: estimateTokens(output) };
}
