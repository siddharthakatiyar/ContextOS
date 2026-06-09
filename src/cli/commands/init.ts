import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { DB, getContextOSHome } from '../../core/storage/database.js';
import { Indexer } from '../../core/indexer/index.js';
import { generateCursorConfig } from '../../mcp/cursor/config-generator.js';

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

    // Deep ignore list for V1
    const ignore = config.ignorePatterns || ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'];
    
    const startTime = Date.now();
    let totalProcessed = 0;
    
    // Index repo layer
    console.log('Indexing repo context...');
    const allRepoFiles = new Set<string>();
    for (const pattern of config.indexablePatterns) {
      const files = await glob(pattern, { cwd, ignore, absolute: true, nodir: true });
      for (const f of files) allRepoFiles.add(f);
    }
    
    for (const file of allRepoFiles) {
      const stats = await indexer.indexFile(file, 'repo');
      if (stats.chunksCreated > 0 || stats.relationshipsFound > 0) totalProcessed++;
    }

    // Index global layer
    console.log('Indexing global context...');
    const globalFiles = await glob('**/*.md', { cwd: globalContextDir, absolute: true, nodir: true });
    for (const file of globalFiles) {
      const stats = await indexer.indexFile(file, 'global');
      if (stats.chunksCreated > 0 || stats.relationshipsFound > 0) totalProcessed++;
    }

    const elapsedMs = Date.now() - startTime;
    console.log(`Indexed ${totalProcessed} changed files (out of ${allRepoFiles.size + globalFiles.length} total files) in ${(elapsedMs/1000).toFixed(1)}s.`);

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
