import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { DB, getContextOSHome } from '../../core/storage/database.js';
import { Indexer } from '../../core/indexer/index.js';
import { generateCursorConfig } from '../../mcp/cursor/config-generator.js';
import cliProgress from 'cli-progress';
import chalk from 'chalk';

export const initCommand = new Command('init')
  .description('Initialize ContextOS in the current repository')
  .action(async () => {
    const cwd = process.cwd();
    const repoContextDir = path.join(cwd, '.contextos');
    const globalContextDir = path.join(getContextOSHome(), 'global');

    // Create directories
    if (!fs.existsSync(repoContextDir)) fs.mkdirSync(repoContextDir, { recursive: true });
    if (!fs.existsSync(globalContextDir)) fs.mkdirSync(globalContextDir, { recursive: true });

    // Create default global template if not exists
    const defaultGlobalDoc = path.join(globalContextDir, 'engineering.md');
    if (!fs.existsSync(defaultGlobalDoc)) {
      fs.writeFileSync(defaultGlobalDoc, '# Global Engineering Rules\n\nAdd your organization-wide engineering rules here.\n');
    }

    console.log(`Initialized ContextOS in ${cwd}`);
    console.log(`Global context dir: ${globalContextDir}`);

    const db = new DB();
    const indexer = new Indexer(db);
    const { loadConfig } = await import('../../config/index.js');
    const config = loadConfig();

    // SAFETY: These patterns are always excluded, regardless of user config
    const SAFETY_IGNORE = [
      '**/node_modules/**',
      '**/.git/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/__pycache__/**',
      '**/target/**',
      '**/*.min.js',
      '**/*.min.css',
      '**/*.map',
      '**/*.lock',
      '**/vendor/**',
    ];
    const userIgnore = config.ignorePatterns || [];
    const ignore = [...new Set([...SAFETY_IGNORE, ...userIgnore])];
    
    const startTime = Date.now();
    let totalProcessed = 0;
    let totalChunks = 0;
    let totalRels = 0;
    
    // Index repo layer
    console.log(chalk.blue.bold('\nIndexing repo context...'));
    const allRepoFiles = new Set<string>();
    for (const pattern of config.indexablePatterns) {
      const files = await glob(pattern, { cwd, ignore, absolute: true, nodir: true });
      for (const f of files) allRepoFiles.add(f);
    }
    
    // Index global layer
    const globalFiles = await glob('**/*.md', { cwd: globalContextDir, absolute: true, nodir: true });
    
    const totalFilesCount = allRepoFiles.size + globalFiles.length;
    
    const bar = new cliProgress.SingleBar({
      format: 'Indexing [{bar}] {percentage}% | {value}/{total} files | {chunks} chunks | {rels} relationships',
      barCompleteChar: '\u2588',
      barIncompleteChar: '\u2591',
      hideCursor: true
    });
    
    bar.start(totalFilesCount, 0, { chunks: 0, rels: 0 });
    
    for (const file of allRepoFiles) {
      try {
        // Skip files larger than 100KB (usually generated/minified)
        const fileStat = fs.statSync(file);
        if (fileStat.size > 100 * 1024) {
          bar.increment({ chunks: totalChunks, rels: totalRels });
          continue;
        }
        const stats = await indexer.indexFile(file, 'repo');
        if (stats.chunksCreated > 0 || stats.relationshipsFound > 0) {
          totalProcessed++;
          totalChunks += stats.chunksCreated;
          totalRels += stats.relationshipsFound;
        }
      } catch (e) {
        // Silently skip failed parses for the progress bar
      }
      bar.increment({ chunks: totalChunks, rels: totalRels });
    }

    for (const file of globalFiles) {
      try {
        const stats = await indexer.indexFile(file, 'global');
        if (stats.chunksCreated > 0 || stats.relationshipsFound > 0) {
          totalProcessed++;
          totalChunks += stats.chunksCreated;
          totalRels += stats.relationshipsFound;
        }
      } catch (e) {}
      bar.increment({ chunks: totalChunks, rels: totalRels });
    }

    bar.stop();

    const elapsedMs = Date.now() - startTime;
    console.log(chalk.green.bold(`\n\u2714 Initialization complete in ${(elapsedMs/1000).toFixed(1)}s`));
    console.log(`Indexed ${totalProcessed} changed files (out of ${totalFilesCount} total files).`);
    console.log(`Generated ${totalChunks} knowledge chunks and ${totalRels} semantic relationships.\n`);

    // Generate cursor config if .cursor exists
    if (fs.existsSync(path.join(cwd, '.cursor'))) {
      const configPath = path.join(cwd, '.cursor', 'mcp.json');
      let config: any = {};
      
      if (fs.existsSync(configPath)) {
        config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
      
      const generated = generateCursorConfig({
        projectRoot: cwd
      });
      
      config.mcpServers = {
        ...config.mcpServers,
        ...generated.mcpServers
      };
      
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      console.log(`Updated Cursor MCP configuration at ${configPath}`);
    }

    console.log('ContextOS initialization complete. You can now use the agent!');
  });
