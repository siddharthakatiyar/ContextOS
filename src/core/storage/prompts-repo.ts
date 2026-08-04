import { Database } from 'better-sqlite3';
import { PromptHistory } from './types.js';
import { prepareCached } from './stmt-cache.js';

interface PromptRow {
  id: string;
  prompt: string;
  extracted_concepts: string | null;
  retrieved_chunk_ids: string | null;
  compiled_token_count: number | null;
  latency_ms: number | null;
  created_at: number;
}

export class PromptsRepo {
  constructor(private db: Database) {}

  public insert(prompt: PromptHistory): void {
    const stmt = prepareCached(
      this.db,
      `
      INSERT INTO prompts (
        id, prompt, extracted_concepts, retrieved_chunk_ids, compiled_token_count, latency_ms, created_at
      ) VALUES (
        @id, @prompt, @extractedConcepts, @retrievedChunkIds, @compiledTokenCount, @latencyMs, @createdAt
      )
    `
    );
    stmt.run(prompt);
  }

  public getRecent(limit: number = 5): PromptHistory[] {
    const stmt = prepareCached(this.db, 'SELECT * FROM prompts ORDER BY created_at DESC LIMIT ?');
    return (stmt.all(limit) as PromptRow[]).map((r) => this.mapRow(r));
  }

  private mapRow(row: PromptRow): PromptHistory {
    return {
      id: row.id,
      prompt: row.prompt,
      extractedConcepts: row.extracted_concepts,
      retrievedChunkIds: row.retrieved_chunk_ids,
      compiledTokenCount: row.compiled_token_count,
      latencyMs: row.latency_ms,
      createdAt: row.created_at
    };
  }
}
