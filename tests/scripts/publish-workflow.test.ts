import fs from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load(source: string): unknown };
interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, string>;
  env?: Record<string, string>;
}
interface Job {
  needs?: string | string[];
  steps: Step[];
  strategy?: { matrix: { os: string[]; node: string[] } };
}

describe('release artifact validation', () => {
  it('publishes the same archive checked by every supported packed-install platform', () => {
    const workflow = yaml.load(
      fs.readFileSync(new URL('../../.github/workflows/npm-publish.yml', import.meta.url), 'utf8')
    ) as { jobs: Record<string, Job> };
    const { prepare, 'packed-install': smoke, 'build-and-publish': publish } = workflow.jobs;
    expect(smoke.needs).toBe('prepare');
    expect(smoke.strategy?.matrix.os).toEqual(['ubuntu-latest', 'macos-latest', 'windows-latest']);
    expect(smoke.strategy?.matrix.node).toEqual(['22.x', '24.x']);
    expect(publish.needs).toEqual(['prepare', 'packed-install']);
    for (const job of [smoke, publish]) {
      expect(job.steps.find((step) => step.uses === 'actions/download-artifact@v4')?.with).toEqual({
        name: 'release-package',
        path: '${{ runner.temp }}/release-package'
      });
      expect(job.steps.some((step) => step.env?.EXPECTED_RELEASE_SHA256)).toBe(true);
    }
    const packed = prepare.steps.filter((step) => step.run?.includes('PACKAGE_TARBALL=$(npm pack'));
    expect(packed).toHaveLength(1);
    expect(
      prepare.steps.some((step) => step.run?.includes('scripts/legacy-upgrade-test.mjs'))
    ).toBe(true);
    const commands = publish.steps.map((step) => step.run ?? '').join('\n');
    expect(commands).toContain('sha256sum --check');
    expect(commands).toContain(
      'npm publish "$RUNNER_TEMP/release-package/contextos.tgz" --ignore-scripts --provenance --access public'
    );
    expect(commands).not.toMatch(/npm (?:pack|ci)|npm run build/);
  });
});
