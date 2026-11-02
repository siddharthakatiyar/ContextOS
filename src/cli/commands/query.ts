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
import { RetrievalChunkExplanation, RetrievalResult } from '../../core/retrieval/types.js';
import { CompilerDiagnostics } from '../../core/compiler/types.js';

function chunkLabel(chunk: RetrievalResult['chunks'][number]): string {
  return chunk.symbolName
    ? `${chunk.symbolKind || 'symbol'} ${chunk.symbolName}`
    : chunk.sectionTitle || chunk.sourceFile;
}

function printQueryExplanation(
  result: RetrievalResult,
  compiler: CompilerDiagnostics | undefined,
  compiledTokenCount: number
): void {
  const explanation = result.explanation;
  console.log(chalk.magenta.bold('\nRetrieval Explanation:'));
  if (!explanation) {
    console.log('  Ranking provenance was not returned by the retrieval engine.');
  } else {
    const embeddings = explanation.embeddingSearch;
    console.log(
      `  Embeddings: configured=${embeddings.configured}, available=${embeddings.available}, searched=${embeddings.searched}, hits=${embeddings.hitCount ?? 'not searched'}, low-confidence fallback=${embeddings.lowConfidenceFallback}${embeddings.failed ? ', search failed' : ''}`
    );
    console.log(
      `  Graph expansion: ${explanation.graphExpansionEnabled ? 'enabled' : 'disabled'}; ${result.expandedEntities.length} related entities found.`
    );
    console.log('  Tracked ranking signals for retrieved chunks:');
    result.chunks.slice(0, 5).forEach((chunk, index) => {
      const signals = explanation.chunks[chunk.id];
      console.log(
        `    ${index + 1}. ${chunkLabel(chunk)} — ${chunk.sourceFile} (final score ${chunk.score.toFixed(2)})`
      );
      if (!signals) {
        console.log('       No per-chunk provenance was returned.');
        return;
      }
      if (signals.sessionContext)
        console.log('       Session context (score from stored importance).');
      if (signals.keyword) {
        const contributions = signals.keyword.contributions
          .slice(0, 4)
          .map((c) => `${c.strategy} rank ${c.rank + 1} (+${c.scoreContribution.toFixed(3)})`);
        console.log(
          `       Keyword RRF ${signals.keyword.rrfScore.toFixed(3)}${contributions.length ? `: ${contributions.join('; ')}` : ''}${signals.keyword.contributions.length > 4 ? '; …' : ''}`
        );
      }
      printChunkSignals(signals);
    });
    console.log(
      '  The final score also includes the retrieval engine’s other scoring adjustments.'
    );
  }

  console.log(chalk.magenta.bold('\nCompilation Choices:'));
  if (!compiler) {
    console.log('  Compiler diagnostics were not returned.');
    return;
  }
  console.log(
    `  Tier: ${compiler.tier}; format: ${compiler.outputFormat}; tokens: ${compiledTokenCount}/${compiler.effectiveMaxTokens} (${compiler.configuredMaxTokens} configured, ${compiler.effectiveMaxTokens} effective); first-pass chunk budget: ${compiler.firstPassChunkBudget}${compiler.repackChunkBudget !== undefined ? `; repack chunk budget: ${compiler.repackChunkBudget}` : ''}; framing reserve: ${compiler.framingReserve}.`
  );
  console.log(`  Signal terms: ${compiler.signalTerms.join(', ') || '(none)'}`);
  console.log(`  Included chunks: ${compiler.includedChunks.length}`);
  for (const included of compiler.includedChunks) {
    const chunk = result.chunks.find((candidate) => candidate.id === included.id);
    console.log(`    - ${chunk ? chunkLabel(chunk) : included.id} (${included.representation})`);
  }
  if (compiler.omittedChunkIds.length > 0) {
    console.log(`  Omitted chunks: ${compiler.omittedChunkIds.length}`);
  }
}

function printChunkSignals(signals: RetrievalChunkExplanation): void {
  if (signals.embedding) {
    if (signals.embedding.action === 'agreement-boost') {
      console.log(
        `       Embedding agreement rank ${signals.embedding.rank}: ${signals.embedding.scoreBefore.toFixed(3)} × ${signals.embedding.multiplier.toFixed(3)} = ${signals.embedding.scoreAfter.toFixed(3)}.`
      );
    } else {
      console.log(
        `       Embedding fallback inserted at rank ${signals.embedding.rank} with score ${signals.embedding.score.toFixed(3)}.`
      );
    }
  }
  if (signals.graph) {
    const graphParts: string[] = [];
    if (signals.graph.matchScore !== undefined) {
      graphParts.push(`match score ${signals.graph.matchScore.toFixed(3)}`);
    }
    if (signals.graph.overlapScoreAdded !== undefined) {
      graphParts.push(`overlap added ${signals.graph.overlapScoreAdded.toFixed(3)}`);
    }
    if (signals.graph.keywordBoost !== undefined) {
      graphParts.push(`entity-keyword boost +${signals.graph.keywordBoost.toFixed(3)}`);
    }
    if (graphParts.length > 0) {
      console.log(
        `       Graph: ${graphParts.join('; ')}${signals.graph.matchedEntities?.length ? ` (matched ${signals.graph.matchedEntities.join(', ')})` : ''}.`
      );
    }
  }
  if (signals.feedback) {
    console.log(
      `       Feedback adjustment ${signals.feedback.adjustment >= 0 ? '+' : ''}${signals.feedback.adjustment.toFixed(3)}.`
    );
  }
}

export const queryCommand = new Command('query')
  .description('Test the retrieval engine with a prompt')
  .argument('<prompt>', 'The user prompt to test')
  .option('--json', 'Output results in JSON format')
  .option('--explain', 'Show retrieval ranking provenance and compilation choices')
  .action(async (prompt: string, options: { json?: boolean; explain?: boolean }) => {
    const dbs = DB.resolveDatabases();
    const chunksRepos = dbs.map((db) => new ChunksRepo(db.getInstance()));
    const relsRepos = dbs.map((db) => new RelationshipsRepo(db.getInstance()));
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

      const result = await engine.retrieve(prompt, options.explain ? { explain: true } : undefined);

      // Add session context
      const sessionChunks = await sessionManager.getSessionContext();
      for (const sc of sessionChunks) {
        result.chunks.push({
          ...sc,
          sourceFile: 'session',
          workspaceName: null,
          sectionTitle: null,
          sectionDepth: 0,
          summary: null,
          keywords: null,
          hash: '',
          tokenCount: 0,
          score: sc.importance,
          createdAt: sc.createdAt ?? Date.now(),
          updatedAt: sc.updatedAt ?? Date.now()
        });
        if (result.explanation) {
          result.explanation.chunks[sc.id] = {
            finalScore: sc.importance,
            sessionContext: true
          };
        }
      }

      const config = loadConfig();
      const compiled = compile(result, {
        maxTokens: config.maxTokenBudget,
        ...(options.explain ? { explain: true } : {})
      });

      if (process.env.TRACE === '1' && !options.json) {
        console.log(chalk.yellow.bold('\n--- [TRACE] RETRIEVAL PIPELINE ---'));
        console.log(chalk.yellow('1. Detected Intent:'));
        console.dir(result.intent, { depth: null, colors: true });
        console.log(chalk.yellow('\n2. Graph Expansion:'));
        console.dir(result.expandedEntities, { depth: null, colors: true });
        console.log(chalk.yellow('\n3. Scored Chunks (Top 10):'));
        console.dir(
          result.chunks
            .slice(0, 10)
            .map((c) => ({ id: c.id, score: c.score, layer: c.layer, symbol: c.symbolName })),
          { depth: null, colors: true }
        );
        console.log(chalk.yellow('----------------------------------\n'));
      }

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              intent: result.intent,
              latencyMs: result.latencyMs,
              chunks: result.chunks,
              expandedEntities: result.expandedEntities,
              context: compiled.output,
              tokens: compiled.tokenCount,
              ...(options.explain
                ? {
                    explanation: {
                      retrieval: result.explanation ?? null,
                      compilation: compiled.diagnostics ?? null
                    }
                  }
                : {})
            },
            null,
            2
          )
        );
      } else {
        console.log(chalk.blue.bold('Intent Detection:'));
        console.log(`  Concepts: [${result.intent.concepts.join(', ')}]`);
        console.log(`  Identifiers: [${result.intent.identifiers.join(', ')}]`);
        console.log(`  Intent Type: ${result.intent.intentType}\n`);

        console.log(
          chalk.blue.bold(
            `Retrieved Chunks (${result.chunks.length} results, ${result.latencyMs}ms):`
          )
        );
        result.chunks.slice(0, 5).forEach((c, i) => {
          console.log(
            `  ${i + 1}. [${c.layer}] ${c.sectionTitle || 'root'} (score: ${c.score?.toFixed(1)})`
          );
        });
        if (result.chunks.length > 5) {
          console.log(`  ... and ${result.chunks.length - 5} more`);
        }
        console.log('');

        console.log(chalk.blue.bold('Graph Expansion:'));
        if (result.expandedEntities.length === 0) {
          console.log('  No related entities found.\n');
        } else {
          result.expandedEntities.slice(0, 5).forEach((e) => {
            console.log(
              `  ${e.entity} (discovered via ${e.relationshipType}, depth: ${e.depth}, score: ${e.score.toFixed(1)})`
            );
          });
          console.log('');
        }

        console.log(chalk.blue.bold(`Compiled Context (${compiled.tokenCount} tokens):`));
        console.log(compiled.output.substring(0, 500) + '...\n[Output truncated]\n');
        if (options.explain)
          printQueryExplanation(result, compiled.diagnostics, compiled.tokenCount);
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
