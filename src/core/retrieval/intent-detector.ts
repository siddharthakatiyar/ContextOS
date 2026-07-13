import { DetectedIntent } from './types.js';
import { STOPWORDS } from '../../utils/stopwords.js';

function tokenize(text: string): string[] {
  // Expand common English contractions before splitting so "What's" → "What" "is"
  // instead of leaving a bare "s" token.
  const expanded = text
    .replace(/\b([A-Za-z]+)'(?:s)\b/g, '$1 is')
    .replace(/\b([A-Za-z]+)'(?:re)\b/gi, '$1 are')
    .replace(/\b([A-Za-z]+)'(?:ve)\b/gi, '$1 have')
    .replace(/\b([A-Za-z]+)'(?:ll)\b/gi, '$1 will')
    .replace(/\b([A-Za-z]+)'(?:d)\b/gi, '$1 would')
    .replace(/\b([Nn])'t\b/g, '$1ot');
  return expanded
    .split(/[^\w\d_.-]+/)
    .filter(Boolean)
    // Drop bare punctuation tokens (e.g. "-" from "events - how")
    .filter(t => !/^[-_.]+$/.test(t))
    // Drop leftover single-letter noise from failed contraction splits
    .filter(t => t.length > 1);
}

function generateNgrams(words: string[], n: number): string[] {
  const ngrams = [];
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.push(words.slice(i, i + n).join(' '));
  }
  return ngrams;
}

/** Multi-token camelCase / PascalCase / snake / UPPER / dotted — not a lone Titlecase word. */
function looksLikeRealIdentifier(id: string): boolean {
  if (/^[a-z]+(?:[A-Z][a-z0-9]*)+$/.test(id)) return true; // camelCase
  if (/^[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]+)+$/.test(id)) return true; // PascalCase 2+ tokens
  if (/^[a-z]+(?:_[a-z0-9]+)+$/.test(id)) return true;
  if (/^[a-z]+(?:\.[a-z]+)+$/.test(id)) return true;
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(id)) return true; // UPPER_CASE
  return false;
}

/** True if match starts a sentence (start of string or after . ! ?). */
function isSentenceInitial(prompt: string, index: number): boolean {
  if (index <= 0) return true;
  const before = prompt.slice(0, index).replace(/^\s+/, '');
  if (!before) return true;
  return /[.!?]\s*$/.test(before);
}

function extractQuotedTerms(prompt: string): string[] {
  // Only balanced straight double-quote pairs — never treat apostrophes as quotes
  const quoted: string[] = [];
  const re = /"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(prompt)) !== null) {
    const term = m[1].trim();
    if (term) quoted.push(term);
  }
  return quoted;
}

export function detectIntent(prompt: string): DetectedIntent {
  const tokens = tokenize(prompt);
  const meaningful = tokens.filter(t => !STOPWORDS.has(t.toLowerCase()));

  const unigramsRaw = meaningful.map(t => t.toLowerCase()).slice(0, 12);
  const unigrams: string[] = [];
  for (const u of unigramsRaw) {
    unigrams.push(u);
    const noExt = u.replace(/\.(ts|tsx|js|jsx|mjs|cjs|md)$/i, '');
    if (noExt !== u && noExt.length >= 3) unigrams.push(noExt);
  }
  const bigrams = generateNgrams(meaningful, 2).map(t => t.toLowerCase()).slice(0, 5);
  const trigrams = generateNgrams(meaningful, 3).map(t => t.toLowerCase()).slice(0, 3);

  const rawIds: string[] = [];
  const patterns: RegExp[] = [
    /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g,       // camelCase
    /\b[a-z]+(?:_[a-z0-9]+)+\b/g,           // snake_case
    /\b[a-z]+(?:\.[a-z]+)+\b/g,             // dot.notation
    /\b[A-Z][a-zA-Z0-9]+\b/g,               // PascalCase / Titlecase
    /\b[A-Z][A-Z0-9_]{2,}\b/g,              // UPPER_CASE
  ];

  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prompt)) !== null) {
      const id = m[0].replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, '');
      if (id.length <= 1) continue;
      if (['DB', 'ID', 'API', 'SQL', 'CLI'].includes(id)) continue;
      if (STOPWORDS.has(id.toLowerCase())) continue;

      // Sentence-initial Titlecase only if it looks like a real multi-token identifier
      if (/^[A-Z][a-z]+$/.test(id) && isSentenceInitial(prompt, m.index)) {
        if (!looksLikeRealIdentifier(id)) continue;
      }

      rawIds.push(id);
    }
  }

  // Synthesize camelCase identifiers from adjacent meaningful words
  // e.g. "query command" → queryCommand, "create session" → createSession
  const synthesized: string[] = [];
  for (let i = 0; i < meaningful.length - 1; i++) {
    const a = meaningful[i].replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, '');
    const b = meaningful[i + 1].replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/i, '');
    if (a.length < 3 || b.length < 3) continue;
    if (STOPWORDS.has(a.toLowerCase()) || STOPWORDS.has(b.toLowerCase())) continue;
    if (/^[-_.]+$/.test(a) || /^[-_.]+$/.test(b)) continue;
    const camel = a.toLowerCase() + b.charAt(0).toUpperCase() + b.slice(1).toLowerCase();
    if (looksLikeRealIdentifier(camel) || /^[a-z]+[A-Z]/.test(camel)) {
      synthesized.push(camel);
    }
    const pascal = a.charAt(0).toUpperCase() + a.slice(1).toLowerCase()
      + b.charAt(0).toUpperCase() + b.slice(1).toLowerCase();
    if (looksLikeRealIdentifier(pascal)) {
      synthesized.push(pascal);
    }
  }

  // Verb-stem + noun synthesis when verb appears as a word in the prompt
  // e.g. create+session → createSession (capped to avoid explosion)
  const verbStems = [
    'create', 'get', 'add', 'load', 'parse', 'start', 'init', 'search',
    'match', 'compile', 'extract', 'register', 'merge', 'expand', 'detect',
  ];
  const nounCandidates = [...new Set([
    ...unigrams.filter(u => u.length >= 4),
    ...unigrams.map(u => u.replace(/s$/, '')).filter(u => u.length >= 4),
  ])].slice(0, 8);
  for (const verb of verbStems) {
    if (!new RegExp(`\\b${verb}`, 'i').test(prompt)) continue;
    for (const noun of nounCandidates) {
      if (noun === verb) continue;
      synthesized.push(verb + noun.charAt(0).toUpperCase() + noun.slice(1));
    }
  }

  // Extract explicit function calls like compile() or myMethod() and backticks like `foo`
  const explicitFuncs: string[] = [];
  const funcCallRe = /\b([a-zA-Z0-9_]+)\(\)/g;
  let fm: RegExpExecArray | null;
  while ((fm = funcCallRe.exec(prompt)) !== null) {
    if (!STOPWORDS.has(fm[1].toLowerCase())) explicitFuncs.push(fm[1]);
  }
  const backtickRe = /`([a-zA-Z0-9_]+)`/g;
  let bm: RegExpExecArray | null;
  while ((bm = backtickRe.exec(prompt)) !== null) {
    if (!STOPWORDS.has(bm[1].toLowerCase())) explicitFuncs.push(bm[1]);
  }

  // Keep multi-token / clearly-identifier shapes; drop leftover stopword-ish singles
  const identifiers = [...new Set([...rawIds, ...synthesized])].filter(id => {
    if (STOPWORDS.has(id.toLowerCase())) return false;
    if (looksLikeRealIdentifier(id)) return true;
    if (/^[A-Z][a-z]+$/.test(id) && id.length >= 4) return true;
    if (/^[a-z]+[A-Z][a-zA-Z]+$/.test(id)) return true; // synthesized camelCase
    return false;
  });

  // Explicit functions and backtick identifiers bypass shape filters unconditionally
  for (const ef of explicitFuncs) {
    identifiers.push(ef);
  }

  // Cap to keep Strategy 2 bounded
  const cappedIdentifiers = identifiers.slice(0, 30);

  const quoted = extractQuotedTerms(prompt);
  const intentType = classifyIntentType(prompt);

  return {
    concepts: [...new Set([...unigrams, ...bigrams, ...trigrams])],
    identifiers: [...new Set(cappedIdentifiers)],
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
  if (/\b(pr|pull request|review)\b/.test(p)) return 'pr';
  return 'general';
}
