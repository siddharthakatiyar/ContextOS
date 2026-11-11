import { WorkspaceRegistry, type ScopeSelectors } from '../../core/workspace/registry.js';
import { WorkspaceRuntime } from '../../core/workspace/runtime.js';
import { retrieveWorkspace } from '../../core/workspace/retrieval.js';
import { compile } from '../../core/compiler/index.js';
import { loadConfig } from '../../config/index.js';

export async function workspaceQuery(
  prompt: string,
  opts: ScopeSelectors & { json?: boolean; explain?: boolean; maxTokens?: string }
): Promise<void> {
  const registry = new WorkspaceRegistry();
  const runtime = new WorkspaceRuntime(registry);
  try {
    const scope = registry.select(opts, process.cwd());
    const result = await retrieveWorkspace(runtime, scope, prompt, { explain: opts.explain });
    const budget = opts.maxTokens ? Number(opts.maxTokens) : loadConfig().maxTokenBudget;
    if (!Number.isInteger(budget) || budget <= 0 || budget > 8000)
      throw new Error('--max-tokens must be an integer between 1 and 8000');
    const compiled = compile(result, {
      maxTokens: budget,
      maxExactTokens: budget,
      sentRegistry: null,
      explain: opts.explain
    });
    const omittedRepositories = scope.sources
      .filter((source) => !compiled.output.includes(source.name + '/'))
      .map((source) => source.name);
    const output = {
      ...result,
      context: compiled.output,
      tokens: compiled.tokenCount,
      omittedRepositories,
      ...(opts.explain
        ? { explanation: { retrieval: result.explanation, compilation: compiled.diagnostics } }
        : {})
    };
    if (opts.json) console.log(JSON.stringify(output, null, 2));
    else {
      console.log(`Repositories: ${scope.sources.map((source) => source.name).join(', ')}`);
      if (result.partial)
        console.log(
          `Partial results: ${result.unavailableSources?.map((source) => `${source.name}: ${source.error}`).join('; ')}`
        );
      console.log(compiled.output);
      if (omittedRepositories.length)
        console.log(
          `No compiled evidence for: ${omittedRepositories.join(', ')} (no matching result or token budget).`
        );
      if (opts.explain) console.log(JSON.stringify(output.explanation, null, 2));
    }
  } finally {
    await runtime.close();
    registry.close();
  }
}
