import path from 'path';

export function scoreFileImportance(filePath: string): number {
  const filename = path.basename(filePath).toLowerCase();
  const dir = path.dirname(filePath).toLowerCase();
  let score = 5; // Default score

  // Highly important structural/config files
  if (filename === 'readme.md') score += 5;
  if (filename === 'package.json') score += 4;
  if (filename === 'tsconfig.json') score += 3;
  if (filename === 'dockerfile' || filename === 'docker-compose.yml') score += 3;

  // Important code entry points
  if (filename === 'index.ts' || filename === 'index.js' || filename === 'main.go' || filename === 'main.rs') {
    score += 4;
  }

  // Common core directories
  if (dir.includes('core') || dir.includes('shared')) score += 2;
  
  // Less important directories
  if (dir.split('/').includes('test') || dir.includes('__tests__') || dir.includes('spec')) {
    score -= 2;
  }
  if (dir.includes('vendor') || dir.includes('node_modules')) {
    score -= 4;
  }
  if (dir.includes('docs')) {
    score -= 1;
  }
  if (dir.includes('mocks') || dir.includes('fixtures')) {
    score -= 3;
  }

  // Ensure score stays within 1-10 range
  return Math.max(1, Math.min(10, score));
}
