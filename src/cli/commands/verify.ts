import { Command } from 'commander';
import { verifyKnowledge } from '../../core/verify/index.js';
import { getErrorMessage } from '../../utils/errors.js';

export const verifyCommand = new Command('verify')
  .description('Recheck saved knowledge against current source evidence')
  .option('--scope <scope>', 'all, group:<name>, view:<id>, project:<id>, or repository selector')
  .option('--dry-run', 'Report without writing lifecycle changes')
  .option('--json', 'Print a structured verification report')
  .option('--fix', 'Persist verification timestamps, anchors and status changes')
  .action(async (options: { scope?: string; dryRun?: boolean; json?: boolean; fix?: boolean }) => {
    try {
      const report = await verifyKnowledge({
        scope: options.scope ?? { cwd: process.cwd() },
        dryRun: !options.fix || !!options.dryRun
      });
      console.log(
        options.json
          ? JSON.stringify(report, null, 2)
          : `${report.checked} knowledge items checked${report.dryRun ? ' (report only)' : ''}: ${Object.entries(
              report.counts
            )
              .map(([key, value]) => `${value} ${key}`)
              .join(', ')}`
      );
    } catch (error) {
      console.error(`Verification failed: ${getErrorMessage(error)}`);
      process.exitCode = 1;
    }
  });
