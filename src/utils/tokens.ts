/**
 * Exact token counts via gpt-tokenizer when available; heuristic fallback otherwise.
 * Fallback retains `codeRatio` / `charsPerToken` for callers and e2e markers.
 *
 * Note: gpt-tokenizer typically counts ~5–10% higher than the legacy heuristic on code.
 * We use exact counts when available so budgets and reported sizes stay honest.
 */
import { createRequire } from 'module';

function heuristicEstimate(text: string): number {
  if (!text) return 0;
  // Code has ~3.5 chars/token, prose ~4.5, mixed ~4
  // Measure punctuation density to estimate how "code-like" the string is
  const codeRatio = (text.match(/[{}();=<>[\].,+*/-]/g)?.length || 0) / text.length;
  // Clamp between 0 and 0.5 (where 0.5 means highly dense code)
  const clampedRatio = Math.min(Math.max(codeRatio, 0), 0.5);
  // Scale from 4.5 (pure text) to 3.0 (dense code) based on punctuation ratio
  const charsPerToken = 4.5 - clampedRatio * 2 * 1.5;
  return Math.ceil(text.length / charsPerToken);
}

type EncodeFn = (text: string) => number[];

let encodeFn: EncodeFn | null = null;
let encodeResolved = false;

function resolveEncode(): EncodeFn | null {
  if (encodeResolved) return encodeFn;
  encodeResolved = true;
  try {
    const require = createRequire(import.meta.url);
    const mod = require('gpt-tokenizer') as { encode?: EncodeFn };
    if (typeof mod.encode === 'function') {
      encodeFn = (text: string) => mod.encode!(text);
    }
  } catch {
    encodeFn = null;
  }
  return encodeFn;
}

import { loadConfig } from '../config/index.js';

export function estimateTokens(text: string): number {
  if (!text) return 0;

  const config = loadConfig();
  const calibration = typeof config.tokenCalibration === 'number' ? config.tokenCalibration : 1.0;

  let count = 0;
  const encode = resolveEncode();
  if (encode) {
    try {
      count = encode(text).length;
    } catch {
      count = heuristicEstimate(text);
    }
  } else {
    count = heuristicEstimate(text);
  }

  return Math.ceil(count * calibration);
}
