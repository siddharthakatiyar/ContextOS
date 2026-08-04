import chalk from 'chalk';
import { ZodError } from 'zod';

/**
 * Global CLI error handler.
 * Formats errors beautifully for the user and hides raw stack traces by default
 * unless DEBUG=1 or --debug is passed.
 */
export function handleCliError(error: unknown) {
  const isDebug = process.env.DEBUG === '1' || process.argv.includes('--debug');

  console.error(''); // Blank line for spacing

  if (error instanceof ZodError) {
    console.error(chalk.red.bold('✖ Configuration Error'));
    error.issues.forEach((issue) => {
      console.error(chalk.red(`  - ${issue.path.join('.')}: ${issue.message}`));
    });
  } else if (error instanceof Error) {
    console.error(chalk.red.bold('✖ Error: ') + chalk.red(error.message));
    if (isDebug && error.stack) {
      console.error(chalk.dim(`\n${error.stack}`));
    }
  } else {
    console.error(chalk.red.bold('✖ Unknown Error: ') + chalk.red(String(error)));
  }

  if (!isDebug) {
    console.error(chalk.dim('\nTip: Run with DEBUG=1 to see the full stack trace.'));
  }
  console.error(''); // Blank line for spacing
  process.exit(1);
}
