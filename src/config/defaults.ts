import path from 'path';
import { getContextOSHome } from '../core/storage/database.js';
import { ContextOSConfig } from './types.js';

export const defaultConfig: ContextOSConfig = {
  dbPath: path.join(process.cwd(), '.contextos', 'index.db'),
  globalContextDir: path.join(getContextOSHome(), 'global'),
  
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
    'node_modules/**',
    '.git/**',
    'dist/**',
    'build/**',
    'vendor/**',
    '*.min.js',
    '*.lock'
  ],
  maxChunkTokens: 1500,
  
  maxRetrievalResults: 15,
  maxTokenBudget: 4000,
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
  
  ftsLimit: 30,
  busyTimeout: 5000,
  
  cursor: {
    autoGenerateConfig: true
  }
};
