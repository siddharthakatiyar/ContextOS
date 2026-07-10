import { scoreChunks } from './src/core/retrieval/scorer.js';

const mockChunks = [
  {
    id: '1',
    sourceFile: '/home/user/project/node_modules/sinon/CHANGELOG.md',
    content: 'v2.0.0...',
    layer: 'repo',
    score: 10
  },
  {
    id: '2',
    sourceFile: '/home/user/project/node_modules/mocha/mocha.js.map',
    content: '{"version":3}',
    layer: 'repo',
    score: 15
  },
  {
    id: '3',
    sourceFile: '/home/user/project/src/errorHandler.ts',
    content: 'function handleError() {}',
    layer: 'repo',
    score: 20
  }
];

const result = scoreChunks(mockChunks as any, []);
console.log('Filtered chunks length:', result.length);
console.log('Surviving files:', result.map(c => c.sourceFile));
