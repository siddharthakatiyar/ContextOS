import { Command } from 'commander';
import {
  listKnowledge,
  setKnowledgeStatus,
  deleteKnowledge,
  sweepExpiredKnowledge,
  reviewScope,
  promoteKnowledge,
  type KnowledgeReviewOptions
} from '../../core/knowledge/review.js';
import type { KnowledgeStatus } from '../../core/knowledge/write-context.js';

type Options = {
  status?: KnowledgeStatus;
  task?: string;
  author?: string;
  scope?: string;
  json?: boolean;
  allProposed?: boolean;
  to?: 'project' | 'group';
  accept?: boolean;
};
export const reviewCommand = new Command('review').description(
  'Inspect, approve and manage saved knowledge'
);
function configure(command: Command) {
  return command
    .option('--scope <selector>', 'all, group:<name>, project:<name>, view:<id>, or repository')
    .option('--json', 'Print JSON');
}
function run(action: () => unknown) {
  try {
    console.log(JSON.stringify(action(), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
function optionsFor(o: Options): KnowledgeReviewOptions {
  return { scope: reviewScope(o.scope) };
}
configure(
  reviewCommand
    .command('list')
    .option('--status <status>', 'proposed, stale or verified')
    .option('--task <id>')
    .option('--author <author>')
).action((o: Options) =>
  run(() => {
    if (o.status && !['proposed', 'stale', 'verified'].includes(o.status))
      throw new Error('Invalid status');
    sweepExpiredKnowledge(optionsFor(o));
    return listKnowledge({ ...optionsFor(o), status: o.status, taskId: o.task, author: o.author });
  })
);
configure(reviewCommand.command('show <id>')).action((id: string, o: Options) =>
  run(() => {
    const record = listKnowledge(optionsFor(o)).find((r) => r.id === id);
    if (!record) throw new Error(`Knowledge not found in selected scope: ${id}`);
    return record;
  })
);
for (const action of ['accept', 'reject', 'promote'] as const) {
  const command = configure(reviewCommand.command(`${action} [ids...]`).option('--task <id>'));
  if (action === 'accept') command.option('--all-proposed');
  if (action === 'promote')
    command.requiredOption('--to <scope>', 'project or group').option('--accept');
  command.action((ids: string[], o: Options) =>
    run(() => {
      const choices = Number(ids.length > 0) + Number(!!o.task) + Number(!!o.allProposed);
      if (choices !== 1)
        throw new Error('Select exactly one of IDs, --task, or --all-proposed (accept only).');
      const options = optionsFor(o);
      const selected = ids.length
        ? ids
        : listKnowledge({
            ...options,
            taskId: o.task,
            ...(action === 'accept' ? { status: 'proposed' as const } : {})
          }).map((r) => r.id);
      if (action === 'accept') {
        const records = listKnowledge(options).filter((r) => selected.includes(r.id));
        if (records.some((r) => r.status !== 'proposed'))
          throw new Error('Accept requires proposed status.');
        return setKnowledgeStatus(selected, 'verified', options);
      }
      if (action === 'reject')
        return deleteKnowledge(selected, { ...options, operation: 'reject' });
      return promoteKnowledge(selected, o.to!, { ...options, accept: o.accept });
    })
  );
}
