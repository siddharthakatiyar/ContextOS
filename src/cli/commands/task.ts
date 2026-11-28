import { Command } from 'commander';
import { deleteByTask, listTasks, reviewScope } from '../../core/knowledge/review.js';
export const taskCommand = new Command('task').description(
  'Inspect task writes and roll them back'
);
const scope = (c: Command) =>
  c
    .option('--scope <selector>', 'Select repository, project, group or all')
    .option('--json', 'Print JSON');
function run(action: () => void) {
  try {
    action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
scope(taskCommand.command('list')).action((o: { scope?: string }) =>
  run(() => console.log(JSON.stringify(listTasks({ scope: reviewScope(o.scope) }), null, 2)))
);
scope(
  taskCommand
    .command('rollback <taskId>')
    .option('--dry-run')
    .option('--yes', 'Confirm deletion of the printed records')
).action((id: string, o: { scope?: string; dryRun?: boolean; yes?: boolean; json?: boolean }) =>
  run(() => {
    const options = { scope: reviewScope(o.scope) };
    const preview = deleteByTask(id, { ...options, dryRun: true });
    // Emit the exact preview before consent checking or mutation. JSON mode
    // streams one object so stdout remains parseable after success or failure.
    if (o.json) process.stdout.write(`{"preview":${JSON.stringify(preview)}`);
    else console.log(JSON.stringify(preview, null, 2));
    try {
      if (o.dryRun) {
        if (o.json) console.log(',"dryRun":true}');
        return;
      }
      if (!o.yes) throw new Error('Rollback requires --yes; no records deleted.');
      const result = deleteByTask(id, {
        ...options,
        expectedIds: preview.records.map((r) => r.id)
      });
      if (o.json) console.log(`,"result":${JSON.stringify(result)}}`);
      else console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      if (o.json)
        console.log(
          `,"error":${JSON.stringify(error instanceof Error ? error.message : String(error))}}`
        );
      throw error;
    }
  })
);
