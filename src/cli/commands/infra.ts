import { Command } from 'commander';
import { importInfra, listInfra } from '../../core/infra/index.js';
import { getErrorMessage } from '../../utils/errors.js';

export const infraCommand = new Command('infra').description(
  'Import and inspect indexed infrastructure knowledge'
);
infraCommand
  .command('import')
  .description('Import deterministic facts and explicit resource references')
  .option('--scope <selector>', 'all, group:<name>, project:<id>, view:<id>, or repository')
  .option('--dry-run', 'Preview without writing knowledge')
  .option('--json', 'Print JSON')
  .action(async (options: { scope?: string; dryRun?: boolean; json?: boolean }) => {
    try {
      const report = await importInfra(options);
      console.log(
        options.json
          ? JSON.stringify(report, null, 2)
          : `${report.dryRun ? 'Planned' : 'Imported'} ${report.views.reduce((n, v) => n + v.facts, 0)} facts and ${report.views.reduce((n, v) => n + v.links, 0)} links across ${report.views.length} views; ${report.skipped.length} skipped relationships/views.`
      );
    } catch (error) {
      console.error(`Infrastructure import failed: ${getErrorMessage(error)}`);
      process.exitCode = 1;
    }
  });
infraCommand
  .command('list')
  .description('List imported knowledge, including retained stale records')
  .option('--scope <selector>', 'Scope selector')
  .option('--json', 'Print JSON')
  .action((options: { scope?: string; json?: boolean }) => {
    try {
      const records = listInfra(options.scope);
      console.log(
        options.json
          ? JSON.stringify(records, null, 2)
          : records
              .map((r) => `${r.id} [${r.status}] ${r.content ?? `${r.source} -> ${r.target}`}`)
              .join('\n') || 'No imported infrastructure knowledge.'
      );
    } catch (error) {
      console.error(`Infrastructure list failed: ${getErrorMessage(error)}`);
      process.exitCode = 1;
    }
  });
