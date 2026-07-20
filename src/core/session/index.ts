import { execFile } from 'child_process';
import { PromptsRepo } from '../storage/prompts-repo.js';
import { SessionChunk } from './types.js';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export * from './types.js';
export * from './session-store.js';

import { SessionStore, shouldRotateSession } from './session-store.js';

const BRANCH_CACHE_TTL_MS = 60_000;

export class SessionManager {
  private sessionId: string;
  private promptsRepo: PromptsRepo;
  private sessionStore: SessionStore;
  private branchCache: { branch: string; at: number } | null = null;

  constructor(promptsRepo: PromptsRepo, sessionStore: SessionStore) {
    this.promptsRepo = promptsRepo;
    this.sessionStore = sessionStore;

    let session = this.sessionStore.getLatestSession();
    if (shouldRotateSession(session)) {
      session = this.sessionStore.createSession(process.cwd());
    }
    this.sessionId = session!.id;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  private async getCachedBranch(): Promise<string | null> {
    const now = Date.now();
    if (this.branchCache && now - this.branchCache.at < BRANCH_CACHE_TTL_MS) {
      return this.branchCache.branch;
    }
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = stdout.trim();
      if (branch) {
        this.branchCache = { branch, at: now };
        return branch;
      }
    } catch {
      // not a git repo or git not installed
    }
    return null;
  }

  public async getSessionContext(): Promise<SessionChunk[]> {
    const chunks: SessionChunk[] = [];

    // 1. Git branch context (cached)
    const branch = await this.getCachedBranch();
    if (branch) {
      chunks.push({
        id: `session:branch:${this.sessionId}`,
        content: `Current git branch: ${branch}`,
        layer: 'session',
        importance: 8,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    // 2. Recent session events (only actionable ones, ignore prompt/retrieval echo)
    const recentEvents = this.sessionStore.getRecentEvents(this.sessionId, 10);
    if (recentEvents && recentEvents.length > 0) {
      const filteredEvents = recentEvents.filter(
        (e) => e.eventType === 'system_response' || e.eventType === 'error'
      );
      if (filteredEvents.length > 0) {
        const eventContent = filteredEvents.map((e) => `[${e.eventType}]: ${e.content}`).join('\n');
        chunks.push({
          id: `session:events:${this.sessionId}`,
          content: `Recent session context:\n${eventContent}`,
          layer: 'session',
          importance: 9,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      }
    }

    return chunks;
  }
}
