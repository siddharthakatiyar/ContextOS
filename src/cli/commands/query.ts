import { Command } from 'commander';
import { DB } from '../../core/storage/database.js';
import { ChunksRepo } from '../../core/storage/chunks-repo.js';
import { RelationshipsRepo } from '../../core/storage/relationships-repo.js';
import { PromptsRepo } from '../../core/storage/prompts-repo.js';
import { SessionStore } from '../../core/session/session-store.js';
import { SessionManager } from '../../core/session/index.js';
import { RetrievalEngine } from '../../core/retrieval/index.js';
import { compile } from '../../core/compiler/index.js';
import { loadConfig } from '../../config/index.js';
import chalk from 'chalk';

export const queryCommand = new Command('query')
  .description('Test the retrieval engine with a prompt')
  .argument('<prompt>', 'The user prompt to test')
  .option('--json', 'Output results in JSON format')
  .action(async (prompt: string, options: { json?: boolean }) => {
    const dbs = DB.resolveDatabases();
    const chunksRepos = dbs.map(db => new ChunksRepo(db.getInstance()));
    const relsRepos = dbs.map(db => new RelationshipsRepo(db.getInstance()));
    const primaryDb = dbs[0];
    const promptsRepo = new PromptsRepo(primaryDb.getInstance());
    const sessionStore = new SessionStore(primaryDb);
    const sessionManager = new SessionManager(promptsRepo, sessionStore);
    const engine = new RetrievalEngine(chunksRepos, relsRepos);

    try {
      if (!options.json) {
        console.log(chalk.bold(`\nQuerying ContextOS with: "${prompt}"\n`));
      }

      sessionStore.addEvent({
        sessionId: sessionManager.getSessionId(),
        eventType: 'user_prompt',
        content: prompt,
        relatedFiles: null
      });

    const result = await engine.retrieve(prompt);
    
    // Add session context
    const sessionChunks = await sessionManager.getSessionContext();
    for (const sc of sessionChunks) {
      result.chunks.push({
        ...sc,
        sourceFile: 'session',
        sectionTitle: null,
        sectionDepth: 0,
        summary: null,
        keywords: null,
        hash: '',
        tokenCount: 0,
        score: sc.importance
      } as any);
    }

    const config = loadConfig();
    const compiled = compile(result, { maxTokens: config.maxTokenBudget });

    if (options.json) {
      console.log(JSON.stringify({
        intent: result.intent,
        latencyMs: result.latencyMs,
        chunks: result.chunks,
        expandedEntities: result.expandedEntities,
        context: compiled.output,
        tokens: compiled.tokenCount
      }, null, 2));
    } else {
      console.log(chalk.blue.bold('Intent Detection:'));
      console.log(`  Concepts: [${result.intent.concepts.join(', ')}]`);
      console.log(`  Identifiers: [${result.intent.identifiers.join(', ')}]`);
      console.log(`  Intent Type: ${result.intent.intentType}\n`);

      console.log(chalk.blue.bold(`Retrieved Chunks (${result.chunks.length} results, ${result.latencyMs}ms):`));
      result.chunks.slice(0, 5).forEach((c, i) => {
        console.log(`  ${i + 1}. [${c.layer}] ${c.sectionTitle || 'root'} (score: ${c.score?.toFixed(1)})`);
      });
      if (result.chunks.length > 5) {
        console.log(`  ... and ${result.chunks.length - 5} more`);
      }
      console.log('');

      console.log(chalk.blue.bold('Graph Expansion:'));
      if (result.expandedEntities.length === 0) {
        console.log('  No related entities found.\n');
      } else {
        result.expandedEntities.slice(0, 5).forEach(e => {
          console.log(`  ${e.entity} (discovered via ${e.relationshipType}, depth: ${e.depth}, score: ${e.score.toFixed(1)})`);
        });
        console.log('');
      }

      console.log(chalk.blue.bold(`Compiled Context (${compiled.tokenCount} tokens):`));
      console.log(compiled.output.substring(0, 500) + '...\n[Output truncated]\n');
    }
    
      sessionStore.addEvent({
        sessionId: sessionManager.getSessionId(),
        eventType: 'context_retrieved',
        content: `Retrieved ${result.chunks.length} chunks. Token count: ${compiled.tokenCount}.`,
        relatedFiles: null
      });
    } finally {
      for (const dbInst of dbs) {
        dbInst.close();
      }
    }
  });
