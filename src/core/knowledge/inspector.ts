import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GraphSource, Evidence, GraphStore } from './graph-store.js';
import type { RepositorySource } from '../workspace/registry.js';
import { entityRef, parseRef } from '../workspace/identity.js';
import { parseCode } from '../parser/code-parser.js';
import { inspectOpenApi, inspectProtobuf } from '../parser/contracts.js';
import { resolveWithinWorkspace } from '../../utils/fs-guard.js';
import type { ParsedCodeDocument } from '../parser/types.js';

type ImportSyntax = Pick<ParsedCodeDocument, 'language' | 'importSpecifiers' | 'importReferences'>;
// Cache syntax only, never resolution, source validity, manifests or graph decisions.
const importSyntaxCache = new Map<string, { hash: string; syntax: ImportSyntax }>();

interface InspectionSource {
  ref: string;
  source: RepositorySource;
  evidence: Evidence;
  content: string;
}
export interface ImportInspection {
  source: string;
  specifier: string;
  symbol?: string;
  mode?: 'import' | 'require' | 'types';
}
export interface ResolvedImport {
  resolved: true;
  relationship: 'imports';
  source: string;
  target: string;
  specifier: string;
  symbol?: string;
  targetProject: string;
  relativePath: string;
  evidence: Evidence[];
  saved: false;
  moduleImportVerified: true;
  symbolUsageVerified: false;
}

/** Exact, on-demand inspection. No model calls, background scans or graph writes. */
export class KnowledgeInspector {
  private parsed = new Map<string, { content: string; document: ReturnType<typeof parseCode> }>();
  constructor(
    private graph: GraphStore,
    private views: RepositorySource[],
    private resolve: (id: string) => GraphSource
  ) {}
  private parse(file: string, content: string): ReturnType<typeof parseCode> {
    let cached = this.parsed.get(file);
    if (!cached || cached.content !== content) {
      cached = { content, document: parseCode(file, content) };
      this.parsed.set(file, cached);
    }
    return cached.document;
  }
  private async importSyntax(source: InspectionSource): Promise<ImportSyntax> {
    const file = source.evidence.file;
    const cached = importSyntaxCache.get(file);
    if (cached?.hash === source.evidence.fileHash) return cached.syntax;
    const { language, importSpecifiers, importReferences } = await this.parse(file, source.content);
    const syntax = { language, importSpecifiers, importReferences };
    if ((importSpecifiers?.length ?? 0) <= 256 && (importReferences?.length ?? 0) <= 256) {
      if (importSyntaxCache.size >= 128)
        importSyntaxCache.delete(importSyntaxCache.keys().next().value!);
      importSyntaxCache.set(file, { hash: source.evidence.fileHash, syntax });
    }
    return syntax;
  }
  private readRef(ref: string): InspectionSource {
    const parsed = parseRef(ref);
    if (!parsed || parsed.kind !== 'chunk')
      throw new Error('Expected a qualified chunk reference.');
    if (!this.views.some((view) => view.repoId === parsed.repoId))
      throw new Error('Reference is outside the selected views.');
    const evidence = this.graph.captureEvidence(ref);
    return {
      ref,
      evidence,
      source: this.resolve(parsed.repoId).source,
      content: fs.readFileSync(evidence.file, 'utf8')
    };
  }
  private readFile(view: RepositorySource, file: string, symbol?: string): InspectionSource {
    if (!this.views.some((selected) => selected.repoId === view.repoId))
      throw new Error('File is outside the selected views.');
    const canonical = resolveWithinWorkspace(view.rootPath, file);
    if (!canonical) throw new Error('File escapes its registered root.');
    const { db } = this.resolve(view.repoId);
    const rows = db
      .prepare(
        `SELECT id,symbol_name FROM chunks WHERE source_file=? ORDER BY CASE WHEN section_title='File Structure' THEN 0 ELSE 1 END,start_line,id`
      )
      .all(canonical) as { id: string; symbol_name: string | null }[];
    const matching = symbol ? rows.filter((row) => row.symbol_name === symbol) : rows;
    if (!matching.length)
      throw new Error(
        `Index ${path.relative(view.rootPath, canonical)}${symbol ? ' and its exported symbol' : ''} before resolving this connection.`
      );
    if (symbol && matching.length !== 1)
      throw new Error('The exported symbol does not resolve uniquely.');
    return this.readRef(entityRef(view.repoId, 'chunk', matching[0].id));
  }
  private owner(file: string): RepositorySource {
    const canonical = fs.realpathSync(file);
    const selected = this.views
      .filter(
        (view) => canonical === view.rootPath || canonical.startsWith(view.rootPath + path.sep)
      )
      .sort((a, b) => b.rootPath.length - a.rootPath.length);
    if (!selected.length)
      throw new Error('The exact dependency target is outside the selected views.');
    if (selected.length > 1 && selected[0].rootPath === selected[1].rootPath)
      throw new Error('Select one target worktree view.');
    return selected[0];
  }
  private manifest(source: InspectionSource, name: string): InspectionSource {
    let directory = path.dirname(source.evidence.file);
    while (
      directory === source.source.rootPath ||
      directory.startsWith(source.source.rootPath + path.sep)
    ) {
      const file = path.join(directory, name);
      if (fs.existsSync(file)) return this.readFile(source.source, file);
      if (directory === source.source.rootPath) break;
      directory = path.dirname(directory);
    }
    throw new Error(`No indexed ${name} establishes a local dependency.`);
  }
  private moduleFile(base: string, allowExtensionFallback = true): string {
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return fs.realpathSync(base);
    if (!allowExtensionFallback || path.extname(base))
      throw new Error('The declared module file is missing; no source mapping is guessed.');
    const candidates = [
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '/index.ts',
      '/index.tsx',
      '/index.js',
      '/index.jsx'
    ]
      .map((suffix) => base + suffix)
      .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
    const unique = [...new Set(candidates.map((file) => fs.realpathSync(file)))];
    if (unique.length !== 1)
      throw new Error(
        'Module entry is missing or does not resolve uniquely; no source mapping is guessed.'
      );
    return unique[0];
  }
  async literalImports(
    ref: string
  ): Promise<NonNullable<Awaited<ReturnType<typeof parseCode>>['importReferences']>> {
    const source = this.readRef(ref);
    const parsed = await this.importSyntax(source);
    return parsed.importReferences ?? [];
  }
  async resolveImport(input: ImportInspection): Promise<ResolvedImport> {
    const source = this.readRef(input.source);
    const parsed = await this.importSyntax(source);
    if (!parsed.importSpecifiers?.includes(input.specifier))
      throw new Error('The source file does not contain this exact import specifier.');
    const evidence = new Map<string, Evidence>([[source.ref, source.evidence]]);
    const remember = (item: InspectionSource) => {
      evidence.set(item.ref, item.evidence);
      return item;
    };
    let file: string;
    let targetView: RepositorySource;
    let analyzedContent: string | undefined;
    if (parsed.language === 'go') {
      const manifest = remember(this.manifest(source, 'go.mod'));
      const module = this.goModule(manifest.content);
      const replacements = this.goReplacements(manifest.content)
        .filter(
          (replacement) =>
            input.specifier === replacement.module ||
            input.specifier.startsWith(replacement.module + '/')
        )
        .sort((a, b) => b.module.length - a.module.length);
      const replacement = replacements[0];
      if (!replacement)
        throw new Error('No explicit local go.mod replacement establishes this dependency.');
      if (replacements.filter((entry) => entry.module === replacement.module).length !== 1)
        throw new Error('Multiple local Go replacements require agent inspection.');
      if (module === replacement.module)
        throw new Error('The replacement does not establish a cross-module dependency.');
      const root = fs.realpathSync(
        path.resolve(path.dirname(manifest.evidence.file), replacement.directory)
      );
      targetView = this.owner(root);
      const targetManifest = remember(this.readFile(targetView, path.join(root, 'go.mod')));
      if (this.goModule(targetManifest.content) !== replacement.module)
        throw new Error('Local module declaration does not match the imported module.');
      const directory = path.join(root, input.specifier.slice(replacement.module.length));
      if (!resolveWithinWorkspace(root, directory))
        throw new Error('Go package escapes the declared module.');
      if (!input.symbol || !/^[A-Z]/.test(input.symbol))
        throw new Error('Provide an exported Go symbol to resolve its defining file.');
      const { db } = this.resolve(targetView.repoId);
      const rows = db
        .prepare('SELECT DISTINCT source_file FROM chunks WHERE symbol_name=?')
        .all(input.symbol) as { source_file: string }[];
      const candidates = rows.filter(
        (row) =>
          path.dirname(row.source_file) === directory && !row.source_file.endsWith('_test.go')
      );
      if (candidates.length !== 1)
        throw new Error('Go export does not resolve uniquely in the imported package.');
      file = candidates[0].source_file;
    } else if (['typescript', 'tsx'].includes(parsed.language)) {
      if (input.specifier.startsWith('.')) {
        file = this.moduleFile(path.resolve(path.dirname(source.evidence.file), input.specifier));
        targetView = this.owner(file);
      } else {
        const packageName = input.specifier.startsWith('@')
          ? input.specifier.split('/').slice(0, 2).join('/')
          : input.specifier.split('/')[0];
        if (!/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(packageName))
          throw new Error(
            'Only literal local package names are resolved; URL and builtin schemes are not package dependencies.'
          );
        const manifest = remember(this.manifest(source, 'package.json'));
        const json = JSON.parse(manifest.content);
        const versions = [
          'dependencies',
          'devDependencies',
          'peerDependencies',
          'optionalDependencies'
        ]
          .map((key) => json[key]?.[packageName])
          .filter((value): value is string => typeof value === 'string');
        if (
          !versions.length ||
          new Set(versions).size !== 1 ||
          !/^(?:file:|link:)/.test(versions[0])
        )
          throw new Error(
            'Only explicit file: or link: dependencies establish a local package here; registry versions and workspace:* are not guessed.'
          );
        const version = versions[0];
        const local = version.startsWith('file://')
          ? fileURLToPath(version)
          : decodeURIComponent(version.replace(/^(?:file:|link:)/, ''));
        const root = fs.realpathSync(path.resolve(path.dirname(manifest.evidence.file), local));
        targetView = this.owner(root);
        const targetManifest = remember(this.readFile(targetView, path.join(root, 'package.json')));
        const target = JSON.parse(targetManifest.content);
        if (target.name !== packageName)
          throw new Error('Local package name does not match the import.');
        const subpath = input.specifier.slice(packageName.length);
        const mode = input.mode ?? 'import';
        let entry: unknown;
        if (target.exports !== undefined) {
          const exports = target.exports;
          if (
            typeof exports === 'object' &&
            exports !== null &&
            Object.keys(exports).some((key) => key.startsWith('.'))
          )
            entry = exports[subpath ? '.' + subpath : '.'];
          else if (!subpath) entry = exports;
          while (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const conditions = entry as Record<string, unknown>;
            if (
              Object.keys(conditions).some(
                (key) => !['types', 'import', 'require', 'default'].includes(key)
              )
            )
              throw new Error('Environment-specific export conditions require agent inspection.');
            // Conditional exports are ordered: an earlier default shadows a later import.
            entry = Object.entries(conditions).find(
              ([key]) => key === mode || key === 'default'
            )?.[1];
          }
          if (typeof entry !== 'string' || !entry.startsWith('./'))
            throw new Error(
              'Package exports do not establish an exact entry for this subpath and condition.'
            );
        } else {
          entry = subpath
            ? '.' + subpath
            : mode === 'types'
              ? (target.types ?? target.typings)
              : (target.main ?? './index.js');
          if (typeof entry !== 'string')
            throw new Error('Package has no entry for the selected condition.');
        }
        file = this.moduleFile(path.resolve(root, entry as string), false);
        if (!resolveWithinWorkspace(root, file))
          throw new Error('Exported entry escapes the declared package root.');
      }
      if (input.symbol) {
        analyzedContent = fs.readFileSync(file, 'utf8');
        const declaration = await this.parse(file, analyzedContent);
        if (
          !declaration.symbols.some(
            (symbol) => symbol.name === input.symbol && /^\s*export\b/.test(symbol.body)
          )
        )
          throw new Error(
            'The target has no direct declaration exporting this symbol; aliases and re-exports require agent inspection.'
          );
      }
    } else
      throw new Error(
        'Exact import inspection currently supports JavaScript/TypeScript and local Go module replacements.'
      );
    const target = remember(this.readFile(targetView, file, input.symbol));
    if (analyzedContent !== undefined && target.content !== analyzedContent)
      throw new Error('Target changed during inspection; reindex and retry.');
    for (const item of evidence.values()) {
      const current = this.graph.captureEvidence(item.ref, item.generation);
      if (
        current.fileHash !== item.fileHash ||
        current.chunkHash !== item.chunkHash ||
        current.file !== item.file
      )
        throw new Error('Evidence changed during inspection; reindex and retry.');
    }
    return {
      resolved: true,
      relationship: 'imports',
      source: source.ref,
      target: target.ref,
      moduleImportVerified: true,
      symbolUsageVerified: false,
      specifier: input.specifier,
      symbol: input.symbol,
      targetProject: target.source.name,
      relativePath: path
        .relative(target.source.rootPath, target.evidence.file)
        .split(path.sep)
        .join('/'),
      evidence: [...evidence.values()],
      saved: false
    };
  }
  private goModule(content: string): string | undefined {
    return /^\s*module\s+(\S+)\s*$/m.exec(content.replace(/\/\/[^\n]*/g, ''))?.[1];
  }
  private goReplacements(content: string): { module: string; directory: string }[] {
    const rows: { module: string; directory: string }[] = [];
    let block = false;
    for (let line of content.replace(/\/\/[^\n]*/g, '').split('\n')) {
      line = line.trim();
      if (/^replace\s*\($/.test(line)) {
        block = true;
        continue;
      }
      if (block && line === ')') {
        block = false;
        continue;
      }
      if (!block && !line.startsWith('replace ')) continue;
      const match = /^(\S+)(?:\s+(\S+))?\s+=>\s+((?:\.{1,2}\/|\/)[^\s]+)$/.exec(
        line.replace(/^replace\s+/, '')
      );
      // Version-specific replacement selection also depends on the effective build list.
      // Leave that to the agent instead of discarding the condition and claiming a match.
      if (match?.[2]) throw new Error('Version-specific Go replacements require agent inspection.');
      if (match) rows.push({ module: match[1], directory: match[3] });
    }
    return rows;
  }
  contract(
    ref: string,
    options: { operation?: string; limit?: number; includeSchemas?: boolean } = {}
  ): Record<string, unknown> {
    const source = this.readRef(ref);
    const contract =
      path.extname(source.evidence.file).toLowerCase() === '.proto'
        ? inspectProtobuf(source.content)
        : inspectOpenApi(source.content);
    if (!contract) throw new Error('The selected file is not an OpenAPI or protobuf contract.');
    const matches = options.operation
      ? contract.operations.filter(
          (operation) =>
            operation.id === options.operation ||
            `${operation.method} ${operation.path}` === options.operation
        )
      : contract.operations;
    if (options.operation && matches.length !== 1)
      throw new Error('The operation is missing or does not resolve uniquely.');
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Contract limit must be between 1 and 100.');
    return {
      ref,
      format: contract.format,
      operations: matches.slice(0, limit),
      schemaNames: Object.keys(contract.schemas).sort().slice(0, 100),
      ...(options.includeSchemas ? { schemas: contract.schemas } : {}),
      evidence: [source.evidence],
      truncated: matches.length > limit || Object.keys(contract.schemas).length > 100,
      externalReferences: 'retained_without_fetching',
      saved: false
    };
  }
}
