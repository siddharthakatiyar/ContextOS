import fs from 'node:fs';
import { globSync } from 'glob';
import type { ContextOSConfig } from '../../config/types.js';
import { infraKind, INFRA_PARSER_VERSION } from '../parser/infra-parser.js';
import { createIndexIgnore } from './ignore.js';

export const INFRA_PATTERNS = [
  '**/Dockerfile*',
  '**/dockerfile*',
  '**/*.sh',
  '**/*.tf',
  '**/.env.example'
];

/** Preserve the pre-infra fingerprint for views with no eligible infra content.
 * The probe is per checkout and never follows symlinks or reads oversized files.
 */
export function infraFingerprint(
  root: string,
  config: ContextOSConfig
): { patterns: string[]; infra?: string } {
  const ignores = createIndexIgnore(root, config.ignorePatterns);
  const files = globSync(
    [...INFRA_PATTERNS, '**/*.yaml', '**/*.yml', '**/tokens.json', '**/*.tfvars.json'],
    {
      cwd: root,
      absolute: true,
      nodir: true,
      follow: false,
      dot: true,
      ignore: ignores.globIgnore.filter((p) => p !== '**/tokens.json' && p !== '**/*.tfvars.json')
    }
  );
  const affected = files.some((file) => {
    // Prior releases could index these JSON credentials; schedule their removal.
    if (/(?:^|[/\\])tokens\.json$|\.tfvars\.json$/i.test(file)) return true;
    if (ignores.ignores(file)) return false;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) return false;
      return !!infraKind(file, /\.ya?ml$/i.test(file) ? fs.readFileSync(file, 'utf8') : undefined);
    } catch {
      return false;
    }
  });
  return affected
    ? {
        patterns: config.indexablePatterns,
        infra: `${INFRA_PARSER_VERSION}:${config.indexing?.infra !== false}`
      }
    : { patterns: config.indexablePatterns.filter((p) => !INFRA_PATTERNS.includes(p)) };
}
