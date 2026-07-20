import { DB } from '../storage/database.js';
import crypto from 'crypto';

export interface FeedbackSignal {
  id: string;
  chunk_id: string;
  score_adjustment: number;
  reason?: string;
  created_at: number;
}

export class FeedbackTracker {
  constructor(private db: DB) {}

  public recordFeedback(chunkId: string, adjustment: number, reason?: string): string {
    const id = crypto.randomUUID();
    const now = Date.now();

    // Insert feedback signal
    this.db
      .getInstance()
      .prepare(
        `
      INSERT INTO feedback_signals (id, chunk_id, score_adjustment, reason, created_at)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(id, chunkId, adjustment, reason || null, now);

    // Also permanently boost the base importance of the file slightly if positive
    if (adjustment > 0) {
      this.db
        .getInstance()
        .prepare(
          `
        UPDATE files 
        SET importance = MIN(importance + 1, 10)
        WHERE path = (SELECT source_file FROM chunks WHERE id = ?)
      `
        )
        .run(chunkId);
    } else if (adjustment < 0) {
      this.db
        .getInstance()
        .prepare(
          `
        UPDATE files 
        SET importance = MAX(importance - 1, 1)
        WHERE path = (SELECT source_file FROM chunks WHERE id = ?)
      `
        )
        .run(chunkId);
    }

    return id;
  }

  public getChunkAdjustments(chunkIds: string[]): Record<string, number> {
    if (!chunkIds || chunkIds.length === 0) return {};

    const placeholders = chunkIds.map(() => '?').join(',');
    const results = this.db
      .getInstance()
      .prepare(
        `
      SELECT chunk_id, SUM(score_adjustment) as total_adjustment
      FROM feedback_signals
      WHERE chunk_id IN (${placeholders})
      GROUP BY chunk_id
    `
      )
      .all(...chunkIds) as any[];

    const adjustments: Record<string, number> = {};
    for (const r of results) {
      adjustments[r.chunk_id] = r.total_adjustment;
    }

    return adjustments;
  }
}
