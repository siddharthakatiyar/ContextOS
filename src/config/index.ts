import fs from 'fs';
import path from 'path';
import { defaultConfig } from './defaults.js';
import { ContextOSConfig, configJsonSchema } from './types.js';
import { getContextOSHome } from '../core/storage/database.js';

export * from './types.js';

let cachedConfig: ContextOSConfig | null = null;

export function loadConfig(opts?: { forceReload?: boolean; cwd?: string }): ContextOSConfig {
  if (cachedConfig && !opts?.forceReload) {
    return cachedConfig;
  }

  let config = structuredClone(defaultConfig);

  const globalConfigPath = path.join(getContextOSHome(), 'config.json');
  if (fs.existsSync(globalConfigPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(globalConfigPath, 'utf8'));
      const validated = validateConfigJson(raw, globalConfigPath);
      if (validated) {
        config = mergeDeep(config, validated);
      }
    } catch (e) {
      console.error(`Error loading global config:`, e);
    }
  }

  const cwd = opts?.cwd || process.cwd();
  const repoConfigPath = path.join(cwd, '.contextos', 'config.json');
  if (fs.existsSync(repoConfigPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(repoConfigPath, 'utf8'));
      const validated = validateConfigJson(raw, repoConfigPath);
      if (validated) {
        config = mergeDeep(config, validated);
      }
    } catch (e) {
      console.error(`Error loading repo config:`, e);
    }
  }

  cachedConfig = config;
  return config;
}

/**
 * Validate a loaded config.json object against the known-key schema.
 * Unknown keys are stripped (with a warning). Returns null if validation fails hard.
 */
export function validateConfigJson(raw: unknown, sourcePath?: string): Record<string, unknown> | null {
  const result = configJsonSchema.safeParse(raw);
  if (!result.success) {
    console.error(
      `Invalid config${sourcePath ? ` at ${sourcePath}` : ''}:`,
      result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')
    );
    return null;
  }

  const data = result.data as Record<string, unknown>;
  const knownKeys = new Set(Object.keys(configJsonSchema.shape));
  // Also treat keys ending with `!` as known when the base key is known (array replace overrides).
  for (const key of Object.keys(data)) {
    const baseKey = key.endsWith('!') ? key.slice(0, -1) : key;
    if (!knownKeys.has(baseKey)) {
      console.warn(`Unknown config key "${key}"${sourcePath ? ` in ${sourcePath}` : ''} — ignoring.`);
      delete data[key];
    }
  }

  return data;
}

/**
 * Deep-merge source into target.
 *
 * Array override: a key ending with `!` (e.g. `"ignorePatterns!": [...]`) REPLACES
 * the target array instead of union-merging. The `!` suffix is stripped when applying.
 * Nested objects still use recursive mergeDeep.
 */
function mergeDeep(target: any, source: any): any {
  if (isObject(target) && isObject(source)) {
    for (const key of Object.keys(source)) {
      // Keys ending with `!` replace arrays (or overwrite scalars) instead of union-merging.
      const replace = key.endsWith('!');
      const actualKey = replace ? key.slice(0, -1) : key;
      const value = source[key];

      if (replace) {
        Object.assign(target, { [actualKey]: Array.isArray(value) ? [...value] : value });
      } else if (isObject(value)) {
        if (!target[actualKey]) Object.assign(target, { [actualKey]: {} });
        mergeDeep(target[actualKey], value);
      } else if (Array.isArray(value)) {
        if (Array.isArray(target[actualKey])) {
          target[actualKey] = Array.from(new Set([...target[actualKey], ...value]));
        } else {
          Object.assign(target, { [actualKey]: value });
        }
      } else {
        Object.assign(target, { [actualKey]: value });
      }
    }
  }
  return target;
}

function isObject(item: any) {
  return (item && typeof item === 'object' && !Array.isArray(item));
}

/** Exported for tests. */
export { mergeDeep };
