import { Command } from 'commander';
import { DB } from '../../core/storage/database.js';
import chalk from 'chalk';

export const analyticsCommand = new Command('analytics')
  .description('Show context retrieval analytics and prompt history stats')
  .action(async () => {
    const db = new DB();
    const dbInstance = db.getInstance();
    
    console.log(chalk.bold(`\nContextOS Analytics\n`));

    const totalPrompts = dbInstance.prepare('SELECT COUNT(*) as count FROM prompts').get() as any;
    
    if (!totalPrompts || totalPrompts.count === 0) {
      console.log('No prompt history found.');
      return;
    }

    const stats = dbInstance.prepare(`
      SELECT 
        AVG(compiled_token_count) as avgTokens,
        MAX(compiled_token_count) as maxTokens,
        AVG(latency_ms) as avgLatency,
        MAX(latency_ms) as maxLatency
      FROM prompts
    `).get() as any;

    console.log(chalk.blue('Overall Stats:'));
    console.log(`  Total Queries: ${totalPrompts.count}`);
    console.log(`  Avg Tokens per Query: ${Math.round(stats.avgTokens)}`);
    console.log(`  Max Tokens Sent: ${Math.round(stats.maxTokens)}`);
    console.log(`  Avg Retrieval Latency: ${Math.round(stats.avgLatency)}ms`);
    console.log(`  Max Retrieval Latency: ${Math.round(stats.maxLatency)}ms\n`);

    console.log(chalk.blue('Recent Queries:'));
    const recent = dbInstance.prepare('SELECT prompt, compiled_token_count, latency_ms FROM prompts ORDER BY created_at DESC LIMIT 5').all() as any[];
    for (const row of recent) {
      console.log(`  - "${row.prompt.substring(0, 50)}${row.prompt.length > 50 ? '...' : ''}" (${row.compiled_token_count} tokens, ${row.latency_ms}ms)`);
    }
    console.log();
  });
