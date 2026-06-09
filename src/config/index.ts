import fs from 'fs';
import path from 'path';
import { defaultConfig } from './defaults.js';
import { ContextOSConfig } from './types.js';
import { getContextOSHome } from '../core/storage/database.js';

export * from './types.js';

let cachedConfig: ContextOSConfig | null = null;

export function loadConfig(opts?: { forceReload?: boolean }): ContextOSConfig {
  if (cachedConfig && !opts?.forceReload) {
    return cachedConfig;
  }

  let config = structuredClone(defaultConfig);

  const globalConfigPath = path.join(getContextOSHome(), 'config.json');
  if (fs.existsSync(globalConfigPath)) {
    try {
      const globalConfig = JSON.parse(fs.readFileSync(globalConfigPath, 'utf8'));
      config = mergeDeep(config, globalConfig);
    } catch (e) {
      console.error(`Error loading global config:`, e);
    }
  }

  const repoConfigPath = path.join(process.cwd(), '.contextos', 'config.json');
  if (fs.existsSync(repoConfigPath)) {
    try {
      const repoConfig = JSON.parse(fs.readFileSync(repoConfigPath, 'utf8'));
      config = mergeDeep(config, repoConfig);
    } catch (e) {
      console.error(`Error loading repo config:`, e);
    }
  }

  cachedConfig = config;
  return config;
}

function mergeDeep(target: any, source: any): any {
  if (isObject(target) && isObject(source)) {
    for (const key in source) {
      if (isObject(source[key])) {
        if (!target[key]) Object.assign(target, { [key]: {} });
        mergeDeep(target[key], source[key]);
      } else {
        Object.assign(target, { [key]: source[key] });
      }
    }
  }
  return target;
}

function isObject(item: any) {
  return (item && typeof item === 'object' && !Array.isArray(item));
}
