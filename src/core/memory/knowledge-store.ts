import { DB } from '../storage/database.js';
import crypto from 'crypto';
import { loadConfig } from '../../config/index.js';

export interface KnowledgeFact {
  id: string;
  fact: string;
  confidence: number;
  category: string;
  created_at: number;
  updated_at: number;
  last_accessed: number;
  access_count: number;
}

export class KnowledgeStore {
  constructor(private db: DB) {}

  public learnFact(fact: string, category: string = 'general'): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    
    // Check if a similar fact exists (simple duplicate check for now, can be improved with embeddings)
    const existing = this.db.getInstance().prepare('SELECT id, fact FROM knowledge_facts WHERE fact = ?').get(fact) as any;
    
    if (existing) {
      // Reinforce existing fact
      this.db.getInstance().prepare(`
        UPDATE knowledge_facts 
        SET confidence = MIN(confidence + 0.1, 1.0), 
            updated_at = ?,
            last_accessed = ?,
            access_count = access_count + 1
        WHERE id = ?
      `).run(now, now, existing.id);
      return existing.id;
    }

    this.db.getInstance().prepare(`
      INSERT INTO knowledge_facts (id, fact, confidence, category, created_at, updated_at, last_accessed, access_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, fact, 1.0, category, now, now, now, 1);

    return id;
  }

  public forgetFact(id: string): boolean {
    const result = this.db.getInstance().prepare('DELETE FROM knowledge_facts WHERE id = ?').run(id);
    return result.changes > 0;
  }

  public searchFacts(query: string, limit: number = 10): KnowledgeFact[] {
    const now = Date.now();
    // Decay confidence of all facts slightly on read to implement forgetting curve
    this.applyDecay(now);

    // Escape query for FTS
    const safeQuery = query.replace(/["']/g, '').split(/\s+/).map(w => `"${w}"*`).join(' OR ');
    
    if (!safeQuery.trim()) return [];

    const facts = this.db.getInstance().prepare(`
      SELECT k.*, f.rank 
      FROM knowledge_facts_fts f
      JOIN knowledge_facts k ON f.rowid = k.rowid
      WHERE knowledge_facts_fts MATCH ?
      ORDER BY k.confidence * f.rank DESC, k.updated_at DESC
      LIMIT ?
    `).all(safeQuery, limit) as KnowledgeFact[];

    if (facts.length > 0) {
      // Update access stats for retrieved facts
      const ids = facts.map(f => `'${f.id}'`).join(',');
      this.db.getInstance().prepare(`
        UPDATE knowledge_facts 
        SET last_accessed = ?, access_count = access_count + 1 
        WHERE id IN (${ids})
      `).run(now);
    }

    return facts;
  }
  
  public getRelevantFactsByCategory(category: string, limit: number = 5): KnowledgeFact[] {
    const now = Date.now();
    this.applyDecay(now);
    
    return this.db.getInstance().prepare(`
      SELECT * FROM knowledge_facts 
      WHERE category = ? AND confidence > 0.3
      ORDER BY confidence DESC, updated_at DESC
      LIMIT ?
    `).all(category, limit) as KnowledgeFact[];
  }

  public getAllFacts(limit: number = loadConfig().ftsLimit): KnowledgeFact[] {
    return this.db.getInstance().prepare(`
      SELECT * FROM knowledge_facts 
      ORDER BY confidence DESC 
      LIMIT ?
    `).all(limit) as KnowledgeFact[];
  }

  private applyDecay(now: number) {
    // Reduce confidence by 0.05 for facts not accessed in the last 7 days
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const cutoff = now - sevenDaysMs;
    
    this.db.getInstance().prepare(`
      UPDATE knowledge_facts 
      SET confidence = MAX(confidence - 0.05, 0.1)
      WHERE last_accessed < ? AND confidence > 0.1
    `).run(cutoff);
    
    // Hard delete facts that have decayed below 0.15 and haven't been accessed in 30 days
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const hardCutoff = now - thirtyDaysMs;
    
    this.db.getInstance().prepare(`
      DELETE FROM knowledge_facts 
      WHERE confidence < 0.15 AND last_accessed < ?
    `).run(hardCutoff);
  }
}
