import { DetectedIntent } from './types.js';
import { STOPWORDS } from '../../utils/stopwords.js';

function tokenize(text: string): string[] {
  return text.split(/[^\w\d_.-]+/).filter(Boolean);
}

function generateNgrams(words: string[], n: number): string[] {
  const ngrams = [];
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.push(words.slice(i, i + n).join(' '));
  }
  return ngrams;
}

export function detectIntent(prompt: string): DetectedIntent {
  const tokens = tokenize(prompt);
  const meaningful = tokens.filter(t => !STOPWORDS.has(t.toLowerCase()));
  
  const unigrams = meaningful.map(t => t.toLowerCase()).slice(0, 10);
  const bigrams = generateNgrams(meaningful, 2).map(t => t.toLowerCase()).slice(0, 5);
  const trigrams = generateNgrams(meaningful, 3).map(t => t.toLowerCase()).slice(0, 3);
  
  const identifiers = prompt.match(/\b[a-z]+(?:[A-Z][a-z]+)+\b/g)    // camelCase
    ?.concat(prompt.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])           // snake_case
    ?.concat(prompt.match(/\b[a-z]+(?:\.[a-z]+)+\b/g) ?? []) ?? [];   // dot.notation
  
  const quoted = prompt.match(/"([^"]+)"|'([^']+)'/g)
    ?.map(q => q.replace(/['"]/g, '')) ?? [];
  
  const intentType = classifyIntentType(prompt);

  return {
    concepts: [...new Set([...unigrams, ...bigrams, ...trigrams])],
    identifiers: [...new Set(identifiers)],
    quotedTerms: [...new Set(quoted)],
    intentType,
    rawPrompt: prompt,
  };
}

function classifyIntentType(prompt: string): string {
  const p = prompt.toLowerCase();
  if (/\b(fix|bug|error|issue|broken|crash)\b/.test(p)) return 'fix';
  if (/\b(add|implement|create|build|new)\b/.test(p)) return 'implement';
  if (/\b(explain|describe|understand)\b/.test(p)) return 'explain';
  if (/\b(refactor|clean|improve|optimize)\b/.test(p)) return 'refactor';
  if (/\b(deploy|release|ship|merge)\b/.test(p)) return 'deploy';
  if (/\b(test|spec|coverage)\b/.test(p)) return 'test';
  return 'general';
}
