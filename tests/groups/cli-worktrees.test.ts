import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

describe('global group/worktree CLI flow', () => {
  it('initializes an unborn Git branch without requiring a first commit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-unborn-'));
    const home = path.join(root, 'home');
    const project = path.join(root, 'new-project');
    fs.mkdirSync(home);
    fs.mkdirSync(project);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CONTEXTOS_EMBEDDINGS: '0' };
    const cli = path.resolve('dist/bin/contextos.js');
    const run = (args: string[]) =>
      execFileSync(process.execPath, [cli, ...args], {
        cwd: project,
        env,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    try {
      execFileSync('git', ['init', '-b', 'main', project], { env, stdio: 'ignore' });
      fs.writeFileSync(
        path.join(project, 'first.ts'),
        'export function initialPayment(): string { return "new"; }\n'
      );
      run(['init']);
      const result = JSON.parse(run(['query', 'initialPayment', '--json']));
      expect(result.scope.sources[0]).toMatchObject({ branch: 'main', head: null });
      expect(
        result.chunks.some((chunk: { symbolName: string }) => chunk.symbolName === 'initialPayment')
      ).toBe(true);
      expect(fs.existsSync(path.join(project, '.contextos'))).toBe(false);
      const profiled = JSON.parse(
        run(['--profile', '--trace', 'query', 'initialPayment', '--json'])
      );
      expect(profiled.scope.sources[0].branch).toBe('main');
      expect(profiled.explanation.retrieval.chunks).toBeDefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);

  it('discovers linked worktrees, isolates branch results, and cleans removed views without source state folders', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-flow-'));
    const home = path.join(root, 'home');
    fs.mkdirSync(home);
    const env = { ...process.env, HOME: home, USERPROFILE: home, CONTEXTOS_EMBEDDINGS: '0' };
    const cli = path.resolve('dist/bin/contextos.js');
    const run = (args: string[], cwd = root) =>
      execFileSync(process.execPath, [cli, ...args], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    const git = (cwd: string, args: string[]) =>
      execFileSync('git', ['-C', cwd, ...args], {
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    const backend = path.join(root, 'backend');
    fs.mkdirSync(backend);
    const feature = path.join(root, 'backend-refunds');
    try {
      git(backend, ['init', '-b', 'main']);
      git(backend, ['config', 'user.name', 'Test']);
      git(backend, ['config', 'user.email', 'test@example.com']);
      fs.writeFileSync(
        path.join(backend, 'payment.ts'),
        'export function settlePaymentStatus(): string { return "paid"; }\n'
      );
      git(backend, ['add', '.']);
      git(backend, ['commit', '-m', 'main payment']);
      git(backend, ['worktree', 'add', '-b', 'feature/refunds', feature]);
      fs.writeFileSync(
        path.join(feature, 'payment.ts'),
        'export function refundPaymentStatus(): string { return "refunded"; }\n'
      );
      git(feature, ['add', '.']);
      git(feature, ['commit', '-m', 'refund payment']);
      run(['group', 'create', 'payments']);
      const subdirectory = path.join(backend, 'src');
      fs.mkdirSync(subdirectory);
      run(['init', '--group', 'payments'], subdirectory);
      expect(fs.existsSync(path.join(subdirectory, '.mcp.json'))).toBe(false);
      expect(
        JSON.parse(fs.readFileSync(path.join(backend, '.mcp.json'), 'utf8')).mcpServers.contextos
          .args
      ).toEqual(['serve', '--group', 'payments']);
      const views = JSON.parse(run(['worktree', 'list', '--project', 'backend', '--json'])) as {
        projectId: string;
        viewId: string;
        branch: string;
        dbPath: string;
      }[];
      expect(views).toHaveLength(2);
      expect(new Set(views.map((v) => v.projectId)).size).toBe(1);
      expect(new Set(views.map((v) => v.viewId)).size).toBe(2);
      for (const view of views)
        expect(view.dbPath.startsWith(path.join(home, '.contextos', 'projects'))).toBe(true);
      expect(fs.existsSync(path.join(backend, '.contextos'))).toBe(false);
      expect(fs.existsSync(path.join(feature, '.contextos'))).toBe(false);
      const main = JSON.parse(run(['query', 'settlePaymentStatus', '--json'], backend));
      expect(
        main.chunks.some((c: { symbolName: string }) => c.symbolName === 'settlePaymentStatus')
      ).toBe(true);
      expect(main.scope.sources).toHaveLength(1);
      expect(main.scope.sources[0].branch).toBe('main');
      const refunds = JSON.parse(run(['query', 'refundPaymentStatus', '--json'], feature));
      expect(
        refunds.chunks.some((c: { symbolName: string }) => c.symbolName === 'refundPaymentStatus')
      ).toBe(true);
      expect(refunds.scope.sources[0].branch).toBe('feature/refunds');
      const combined = JSON.parse(
        run([
          'query',
          'payment status',
          '--group',
          'payments',
          '--all-worktrees',
          '--json',
          '--max-tokens',
          '4000'
        ])
      );
      expect(combined.scope.sources).toHaveLength(2);
      expect(combined.context).toContain('feature/refunds');
      expect(combined.context).toContain('main');
      const removed = views.find((v) => v.branch === 'feature/refunds')!;
      git(backend, ['worktree', 'remove', '--force', feature]);
      const preview = JSON.parse(run(['clean', '--dry-run']));
      expect(
        preview.actions.some((a: { viewIds: string[] }) => a.viewIds.includes(removed.viewId))
      ).toBe(true);
      expect(fs.existsSync(removed.dbPath)).toBe(true);
      run(['clean']);
      expect(fs.existsSync(path.dirname(removed.dbPath))).toBe(false);
      expect(fs.existsSync(views.find((v) => v.branch === 'main')!.dbPath)).toBe(true);
      run(['project', 'remove', 'backend', '--purge']);
      expect(fs.existsSync(path.join(backend, 'payment.ts'))).toBe(true);
      expect(JSON.parse(run(['project', 'list', '--json'])).repositories).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
