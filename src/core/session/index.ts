import { execFile } from 'child_process';
import { PromptsRepo } from '../storage/prompts-repo.js';
import { SessionChunk } from './types.js';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export * from './types.js';
export * from './session-store.js';

import { SessionStore } from './session-store.js';

export class SessionManager {
  private sessionId: string;
  private promptsRepo: PromptsRepo;
  private sessionStore: SessionStore;

  constructor(promptsRepo: PromptsRepo, sessionStore: SessionStore) {
    this.promptsRepo = promptsRepo;
    this.sessionStore = sessionStore;
    
    // Ensure we have a persistent session
    let session = this.sessionStore.getLatestSession();
    // If no session exists or the latest is too old (e.g., > 1 day), we could create a new one.
    // For now, let's create one if none exists.
    if (!session) {
      session = this.sessionStore.createSession(process.cwd());
    }
    this.sessionId = session.id;
  }

  public getSessionId(): string {
    return this.sessionId;
  }

  public async getSessionContext(): Promise<SessionChunk[]> {
    const chunks: SessionChunk[] = [];
    
    // 1. Git branch context
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
      const branch = stdout.trim();
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
    } catch (e) {
      // not a git repo or git not installed, ignore
    }
    
    // 2. Recent session events
    const recentEvents = this.sessionStore.getRecentEvents(this.sessionId, 10);
    if (recentEvents && recentEvents.length > 0) {
      const eventContent = recentEvents.map(e => `[${e.eventType}]: ${e.content}`).join('\n');
      chunks.push({
        id: `session:events:${this.sessionId}`,
        content: `Recent session context:\n${eventContent}`,
        layer: 'session',
        importance: 9,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }

    // 3. Recent prompts fallback (legacy)
    const recentPrompts = this.promptsRepo.getRecent(5);
    if (recentPrompts && recentPrompts.length > 0) {
      chunks.push({
        id: `session:history:${this.sessionId}`,
        content: `Recent tasks in this session:\n${recentPrompts.map(p => `- ${p.prompt}`).join('\n')}`,
        layer: 'session',
        importance: 7,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });
    }
    
    return chunks;
  }
}
