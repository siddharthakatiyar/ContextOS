import { Chunk } from '../storage/types.js';

export interface SessionChunk extends Partial<Chunk> {
  id: string;
  content: string;
  layer: 'session';
  importance: number;
}
