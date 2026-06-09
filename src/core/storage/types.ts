export type Layer = 'global' | 'workspace' | 'repo' | 'session';

export interface Chunk {
  id: string;
  sourceFile: string;
  layer: Layer;
  workspaceName: string | null;
  sectionTitle: string | null;
  sectionDepth: number;
  content: string;
  summary: string | null;
  keywords: string | null;
  hash: string;
  importance: number;
  tokenCount: number;
  fileType?: 'markdown' | 'code' | 'config' | 'text';
  language?: string;
  symbolName?: string;
  symbolKind?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FileRecord {
  path: string;
  layer: Layer;
  workspaceName: string | null;
  hash: string;
  lastIndexed: number;
  importance: number;
  chunkCount: number;
}

export interface Relationship {
  id?: number;
  source: string;
  target: string;
  relationshipType: string;
  weight: number;
  sourceChunkId: string | null;
  layer: Layer | null;
  createdAt: number;
}

export interface PromptHistory {
  id: string;
  prompt: string;
  extractedConcepts: string | null;
  retrievedChunkIds: string | null;
  compiledTokenCount: number | null;
  latencyMs: number | null;
  createdAt: number;
}

export interface ChunkStats {
  totalChunks: number;
  byLayer: Record<Layer, number>;
  totalTokens: number;
}

export interface IndexStats {
  filesProcessed: number;
  chunksCreated: number;
  relationshipsFound: number;
  durationMs: number;
}
