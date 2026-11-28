import type { WorkspaceRuntime } from '../workspace/runtime.js';
import type { RetrievalScope } from '../workspace/registry.js';
import { analyzeImpact, readImpactLinks, type ImpactOptions } from './index.js';
import { deploymentImpact } from './deployment.js';
import { gitText } from './diff.js';

export async function workspaceImpact(
  runtime: WorkspaceRuntime,
  selected: RetrievalScope,
  input: Omit<ImpactOptions, 'scope'> & { limit?: number; offset?: number } = {}
) {
  const limit = input.limit ?? 10,
    offset = input.offset ?? 0;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset > 499
  )
    throw new Error('Impact pagination requires limit 1–100 and offset 0–499.');
  const viewId =
    input.viewId ??
    selected.activeRepoId ??
    (selected.sources.length === 1 ? selected.sources[0].repoId : undefined);
  const options: ImpactOptions = {
    ...input,
    viewId,
    maxResults: 500,
    scope: {
      views: selected.sources.map((source) => ({
        source,
        db: runtime.get(source).db.getInstance()
      })),
      links: readImpactLinks(runtime.registry.home, selected.repoIds),
      group: selected.groupId
    }
  };
  if (options.diff === undefined && !options.files && !options.base && !options.head) {
    const source = selected.sources.find((s) => s.repoId === viewId);
    if (!source) throw new Error('Select a view for the working-tree diff.');
    options.diff = gitText(source.rootPath, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--find-renames',
      'HEAD',
      '--'
    ]);
  } else if (options.base && !options.head) options.head = 'HEAD';
  else if (options.head && !options.base) options.base = 'HEAD';
  const result = await analyzeImpact(options);
  const deployment = deploymentImpact(runtime.registry.home, options, result);
  const page = result.impacted.slice(offset, offset + limit);
  const deploymentPage = deployment.items.slice(offset, offset + limit);
  return {
    ...result,
    impacted: page,
    deployment: { ...deployment, items: deploymentPage, total: deployment.items.length },
    pagination: {
      limit,
      offset,
      total: result.impacted.length,
      hasMore: offset + limit < result.impacted.length || offset + limit < deployment.items.length
    },
    ...(!input.verbose
      ? {
          changes: result.changes.map(({ refs: _refs, oldRanges: _oldRanges, ...change }) => change)
        }
      : {})
  };
}
