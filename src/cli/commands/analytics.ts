import { Command } from 'commander';
import { DB } from '../../core/storage/database.js';
import chalk from 'chalk';

interface PromptCountRow {
  count: number;
}

interface PromptStatsRow {
  sumTokens: number | null;
  maxTokens: number | null;
  sumLatency: number | null;
  maxLatency: number | null;
}

interface RecentPromptRow {
  prompt: string;
  compiled_token_count: number;
  latency_ms: number;
  created_at: number;
}

export const analyticsCommand = new Command('analytics')
  .description('Show context retrieval analytics and prompt history stats')
  .action(async () => {
    const dbs = DB.resolveDatabases();

    console.log(chalk.bold(`\nContextOS Analytics\n`));

    let totalQueries = 0;
    let totalTokens = 0;
    let maxTokens = 0;
    let totalLatency = 0;
    let maxLatency = 0;
    const allRecent: RecentPromptRow[] = [];

    for (const db of dbs) {
      const dbInstance = db.getInstance();

      const totalPrompts = dbInstance
        .prepare('SELECT COUNT(*) as count FROM prompts')
        .get() as PromptCountRow;
      if (!totalPrompts || totalPrompts.count === 0) continue;

      const stats = dbInstance
        .prepare(
          `
        SELECT 
          SUM(compiled_token_count) as sumTokens,
          MAX(compiled_token_count) as maxTokens,
          SUM(latency_ms) as sumLatency,
          MAX(latency_ms) as maxLatency
        FROM prompts
      `
        )
        .get() as PromptStatsRow;

      totalQueries += totalPrompts.count;
      totalTokens += stats.sumTokens || 0;
      maxTokens = Math.max(maxTokens, stats.maxTokens || 0);
      totalLatency += stats.sumLatency || 0;
      maxLatency = Math.max(maxLatency, stats.maxLatency || 0);

      const recent = dbInstance
        .prepare(
          'SELECT prompt, compiled_token_count, latency_ms, created_at FROM prompts ORDER BY created_at DESC LIMIT 5'
        )
        .all() as RecentPromptRow[];
      allRecent.push(...recent);
    }

    if (totalQueries === 0) {
      console.log('No prompt history found.');
      return;
    }

    const avgTokens = totalTokens / totalQueries;
    const avgLatency = totalLatency / totalQueries;

    console.log(chalk.blue('Overall Stats:'));
    console.log(`  Total Queries: ${totalQueries}`);
    console.log(`  Avg Tokens per Query: ${Math.round(avgTokens)}`);
    console.log(`  Max Tokens Sent: ${Math.round(maxTokens)}`);
    console.log(`  Avg Retrieval Latency: ${Math.round(avgLatency)}ms`);
    console.log(`  Max Retrieval Latency: ${Math.round(maxLatency)}ms\n`);

    console.log(chalk.blue('Recent Queries:'));
    allRecent.sort((a, b) => b.created_at - a.created_at);
    for (const row of allRecent.slice(0, 5)) {
      console.log(
        `  - "${row.prompt.substring(0, 50)}${row.prompt.length > 50 ? '...' : ''}" (${row.compiled_token_count} tokens, ${row.latency_ms}ms)`
      );
    }
    console.log();
  });
