import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadConfig } from '../../config/index.js';

const MODEL_ID = 'sentence-transformers/all-MiniLM-L6-v2';
const EMBEDDING_DIMS = 384;

type FeatureExtractionPipeline = (
  texts: string | string[],
  opts?: { pooling?: string; normalize?: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

let pipelineFn: FeatureExtractionPipeline | null = null;
let loadPromise: Promise<FeatureExtractionPipeline | null> | null = null;
let unavailable = false;
let loggedUnavailable = false;

function modelsCacheDir(): string {
  return path.join(os.homedir(), '.contextos', 'models');
}

function logUnavailableOnce(reason: string): void {
  if (loggedUnavailable) return;
  loggedUnavailable = true;
  console.error(`[contextos] embeddings unavailable: ${reason}`);
}

/**
 * True when embeddings are enabled and the model pipeline has not been marked unavailable.
 * Returns false immediately if CONTEXTOS_EMBEDDINGS=0 or config.embeddingsEnabled === false.
 */
export function isEmbeddingsAvailable(): boolean {
  if (process.env.CONTEXTOS_EMBEDDINGS === '0') return false;
  try {
    if (loadConfig().embeddingsEnabled === false) return false;
  } catch {
    // Config load failure should not disable embeddings by itself
  }
  return !unavailable;
}

async function loadPipeline(): Promise<FeatureExtractionPipeline | null> {
  if (unavailable) return null;
  if (pipelineFn) return pipelineFn;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const cacheDir = modelsCacheDir();
      fs.mkdirSync(cacheDir, { recursive: true });

      const transformers = await import('@huggingface/transformers');
      const { pipeline, env } = transformers;
      env.cacheDir = cacheDir;
      env.allowLocalModels = true;

      const extractor = await pipeline('feature-extraction', MODEL_ID);
      pipelineFn = extractor as FeatureExtractionPipeline;
      return pipelineFn;
    } catch (e: any) {
      unavailable = true;
      logUnavailableOnce(e?.message || String(e));
      return null;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

function l2Normalize(vec: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0 || !Number.isFinite(norm)) return vec;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

function meanPool(data: Float32Array, dims: number[]): Float32Array {
  if (dims.length === 3) {
    const [, seq, hidden] = dims;
    const out = new Float32Array(hidden);
    for (let s = 0; s < seq; s++) {
      for (let h = 0; h < hidden; h++) {
        out[h] += data[s * hidden + h];
      }
    }
    for (let h = 0; h < hidden; h++) out[h] /= seq;
    return out;
  }
  if (dims.length === 2) {
    const [seq, hidden] = dims;
    if (seq === 1) return data.slice(0, hidden);
    const out = new Float32Array(hidden);
    for (let s = 0; s < seq; s++) {
      for (let h = 0; h < hidden; h++) {
        out[h] += data[s * hidden + h];
      }
    }
    for (let h = 0; h < hidden; h++) out[h] /= seq;
    return out;
  }
  return data.length === EMBEDDING_DIMS ? data : data.slice(0, EMBEDDING_DIMS);
}

/**
 * Embed texts with mean pooling + L2 normalization.
 * Returns empty array (never throws) if the model is unavailable.
 */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  if (!isEmbeddingsAvailable()) return [];

  try {
    const extractor = await loadPipeline();
    if (!extractor) return [];

    const results: Float32Array[] = [];
    for (const text of texts) {
      const output = await extractor(text, { pooling: 'mean', normalize: true });
      const data =
        output?.data instanceof Float32Array ? output.data : new Float32Array(output?.data || []);
      const dims = output?.dims || [data.length];

      let vec: Float32Array;
      if (dims.length === 1 || (dims.length === 2 && dims[0] === 1)) {
        vec = data.length > EMBEDDING_DIMS ? data.slice(0, EMBEDDING_DIMS) : data;
        vec = l2Normalize(vec);
      } else {
        vec = l2Normalize(meanPool(data, dims));
      }
      results.push(vec);
    }
    return results;
  } catch (e: any) {
    unavailable = true;
    logUnavailableOnce(e?.message || String(e));
    return [];
  }
}

export function getEmbeddingModelId(): string {
  return MODEL_ID;
}

export function getEmbeddingDims(): number {
  return EMBEDDING_DIMS;
}

/** Test helper: force unavailable state without loading the model. */
export function _resetEmbedderForTests(opts?: { unavailable?: boolean }): void {
  unavailable = opts?.unavailable ?? false;
  loggedUnavailable = false;
  pipelineFn = null;
  loadPromise = null;
}
