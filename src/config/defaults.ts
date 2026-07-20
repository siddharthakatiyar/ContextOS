import path from 'path';
import os from 'os';
import { ContextOSConfig } from './types.js';

export const defaultConfig: ContextOSConfig = {
  // Note: dbPath is calculated at module-load time, but loadConfig() deep-clones
  // this object so the dbPath will be resolved correctly later.
  get dbPath() {
    return path.join(process.cwd(), '.contextos', 'index.db');
  },
  get globalContextDir() {
    return path.join(os.homedir(), '.contextos', 'global');
  },

  indexablePatterns: [
    '**/*.md',
    '**/*.txt',
    '**/CLAUDE.md',
    '**/SKILLS.md',
    '**/.cursor/rules/**',
    '**/*.ts',
    '**/*.tsx',
    '**/*.js',
    '**/*.jsx',
    '**/*.py',
    '**/*.go',
    '**/*.rs',
    '**/*.java',
    '**/*.c',
    '**/*.cpp',
    '**/*.h',
    '**/*.hpp',
    '**/*.cs',
    '**/*.json',
    '**/*.yaml',
    '**/*.yml',
    '**/*.toml',
    '**/*.ini'
  ],
  ignorePatterns: [
    // SAFETY: critical exclusions — never remove
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    '.next/**',
    'coverage/**',
    '__pycache__/**',
    'target/**',
    'vendor/**',

    // OS-level exclusions to prevent system-wide indexing if homedir is accidentally used
    'Library/**',
    'Applications/**',
    'Downloads/**',
    'Pictures/**',
    'Music/**',
    'Movies/**',
    'go/pkg/**',
    'Desktop/**',

    '*.min.js',
    '*.min.css',
    '*.map',
    '*.lock'
  ],
  maxChunkTokens: 1500,
  /** Function/method bodies above this emit additive segment chunks (parent kept). */
  maxSymbolChunkTokens: 900,

  maxRetrievalResults: 25,
  maxTokenBudget: 1200,
  layerBoosts: {
    session: 1.5,
    repo: 1.3,
    workspace: 1.1,
    global: 1.0
  },
  graphExpansionDepth: 2,
  graphExpansionMaxNodes: 20,
  maxGraphBoost: 10,
  diversityDecay: 0.7,
  diversityPenaltyStart: 3,

  ftsLimit: 15,
  busyTimeout: 5000,

  embeddingsEnabled: true,
  /** When true, fuse embedding kNN into retrieval. Default false — keyword path is the accuracy baseline. */
  embeddingsRetrieval: false,

  cursor: {
    autoGenerateConfig: true
  },

  memoryInjection: 'relevant',
  sentDedupEnabled: true,
  legacyTools: false,
  tokenCalibration: 1.0,
  framingReserve: 48,
  adaptiveResponse: true,
  pipeline: {
    graphExpansion: true,
    embeddingFusion: true,
    containmentDedup: true,
    diversityFilter: true
  }
};
