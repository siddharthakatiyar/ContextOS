import { describe, it, expect } from 'vitest';
import { defaultConfig } from '../../src/config/defaults.js';

describe('v1 config defaults', () => {
  it('embeddingFusion is unset by default (follows embeddingsRetrieval)', () => {
    // Must NOT be `true` — a forced-true default silently enables kNN fusion for
    // everyone, contradicting the documented off-by-default behavior.
    expect(defaultConfig.pipeline?.embeddingFusion).toBeUndefined();
  });

  it('embeddingsRetrieval is off by default', () => {
    expect(defaultConfig.embeddingsRetrieval).toBe(false);
  });

  it('execAllowRepoScripts defaults to true (opt-out, not opt-in)', () => {
    expect(defaultConfig.execAllowRepoScripts).toBe(true);
  });

  it('maxRetrievalResults default matches the documented value', () => {
    expect(defaultConfig.maxRetrievalResults).toBe(25);
  });
});
