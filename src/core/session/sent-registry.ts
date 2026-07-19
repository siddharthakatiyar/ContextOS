export class SentRegistry {
  private sentChunks = new Map<string, { timestamp: number }>();
  private readonly TTL_MS = 15 * 60 * 1000;
  private readonly MAX_SIZE = 200;

  public markSent(hash: string): void {
    if (this.sentChunks.has(hash)) {
      this.sentChunks.delete(hash);
    } else if (this.sentChunks.size >= this.MAX_SIZE) {
      // Evict oldest (Map iterates in insertion order)
      const oldestKey = this.sentChunks.keys().next().value;
      if (oldestKey) this.sentChunks.delete(oldestKey);
    }
    this.sentChunks.set(hash, { timestamp: Date.now() });
  }

  public hasBeenSent(hash: string): boolean {
    const entry = this.sentChunks.get(hash);
    if (!entry) return false;
    
    if (Date.now() - entry.timestamp > this.TTL_MS) {
      this.sentChunks.delete(hash);
      return false;
    }
    
    return true;
  }

  public invalidate(): void {
    this.sentChunks.clear();
  }
}

export const globalSentRegistry = new SentRegistry();
