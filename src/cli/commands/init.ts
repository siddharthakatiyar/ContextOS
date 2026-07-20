import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { DB, getContextOSHome } from '../../core/storage/database.js';
import { Indexer } from '../../core/indexer/index.js';
import { generateCursorConfig } from '../../mcp/cursor/config-generator.js';
import cliProgress from 'cli-progress';
import chalk from 'chalk';
import { pLimit } from '../../utils/concurrency.js';

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
      fs.writeFileSync(
        defaultGlobalDoc,
        '# Global Engineering Rules\n\nAdd your organization-wide engineering rules here.\n'
      );
    }

    console.log(`Initialized ContextOS in ${cwd}`);
    console.log(`Global context dir: ${globalContextDir}`);

    const db = new DB();
    const indexer = new Indexer(db);
    const { loadConfig } = await import('../../config/index.js');
    const config = loadConfig();

    try {
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
        '**/vendor/**'
      ];
      const userIgnore = config.ignorePatterns || [];
      const ignore = [...new Set([...SAFETY_IGNORE, ...userIgnore])];

      const startTime = Date.now();
      const totalProcessed = 0;
      const totalChunks = 0;
      const totalRels = 0;
      const totalFilesCount = 0;

      const abortController = new AbortController();
      const onSigInt = () => {
        console.log(chalk.red('\n\nAborting initialization...'));
        abortController.abort();
      };
      process.on('SIGINT', onSigInt);

      try {
        // Mark repo as needing a full index so the daemon will pick it up
        const statusPath = path.join(repoContextDir, 'status.json');
        fs.writeFileSync(statusPath, JSON.stringify({ fullIndexCompleted: false }));
      } finally {
        process.off('SIGINT', onSigInt);
      }

      const elapsedMs = Date.now() - startTime;
      console.log(
        chalk.green.bold(`\n\u2714 Initialized ContextOS in ${(elapsedMs / 1000).toFixed(1)}s`)
      );
      console.log(`Repository is scheduled for background indexing.\n`);

      // Generate cursor config if .cursor exists
      if (fs.existsSync(path.join(cwd, '.cursor'))) {
        const configPath = path.join(cwd, '.cursor', 'mcp.json');
        let config: any = {};

        if (fs.existsSync(configPath)) {
          config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }

        if (!config.mcpServers) {
          config.mcpServers = {};
        }

        // Only inject contexts if it doesn't already exist, so we don't overwrite manual local testing setups
        if (!config.mcpServers.contextos) {
          const generated = generateCursorConfig({
            projectRoot: cwd
          });

          config.mcpServers = {
            ...config.mcpServers,
            ...generated.mcpServers
          };
        }

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`Updated Cursor MCP configuration at ${configPath}`);
      }

      // Generate Antigravity MCP config
      // 1. Global config: ~/.gemini/config/mcp_config.json (always written)
      const homeDir = process.env.HOME || process.env.USERPROFILE || '';
      const antigravityGlobalDir = path.join(homeDir, '.gemini', 'config');
      if (homeDir) {
        if (!fs.existsSync(antigravityGlobalDir)) {
          fs.mkdirSync(antigravityGlobalDir, { recursive: true });
        }
        const globalConfigPath = path.join(antigravityGlobalDir, 'mcp_config.json');
        let globalConfig: any = {};
        if (fs.existsSync(globalConfigPath)) {
          try {
            const raw = fs.readFileSync(globalConfigPath, 'utf8').trim();
            if (raw) globalConfig = JSON.parse(raw);
          } catch (e) {}
        }
        const generatedAgy = generateCursorConfig({ projectRoot: cwd });
        if (!globalConfig.mcpServers) globalConfig.mcpServers = {};
        globalConfig.mcpServers = {
          ...globalConfig.mcpServers,
          ...generatedAgy.mcpServers
        };
        fs.writeFileSync(globalConfigPath, JSON.stringify(globalConfig, null, 2));
        console.log(`Updated Antigravity global MCP configuration at ${globalConfigPath}`);
      }

      // 2. Project-level config: .agents/mcp_config.json (if .agents dir exists)
      if (fs.existsSync(path.join(cwd, '.agents'))) {
        const configPath = path.join(cwd, '.agents', 'mcp_config.json');
        let config: any = {};
        if (fs.existsSync(configPath)) {
          try {
            const raw = fs.readFileSync(configPath, 'utf8').trim();
            if (raw) config = JSON.parse(raw);
          } catch (e) {}
        }
        const generatedLocal = generateCursorConfig({ projectRoot: cwd });
        if (!config.mcpServers) config.mcpServers = {};
        config.mcpServers = {
          ...config.mcpServers,
          ...generatedLocal.mcpServers
        };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`Updated Antigravity project MCP configuration at ${configPath}`);
      }

      // Generate Claude Code (and generic) MCP config (.mcp.json)
      const claudeConfigPath = path.join(cwd, '.mcp.json');
      let claudeConfig: any = {};
      if (fs.existsSync(claudeConfigPath)) {
        try {
          claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf8'));
        } catch (e) {
          // ignore parse errors
        }
      }
      const generated = generateCursorConfig({ projectRoot: cwd });
      claudeConfig.mcpServers = {
        ...claudeConfig.mcpServers,
        ...generated.mcpServers
      };
      fs.writeFileSync(claudeConfigPath, JSON.stringify(claudeConfig, null, 2));
      console.log(`Updated Claude Code MCP configuration at ${claudeConfigPath}`);

      // Generate VS Code MCP configs (Cline and Roo Code)
      const vscodeDir = path.join(cwd, '.vscode');
      if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
      }

      const vscodeMcpConfigs = [
        { name: 'Cline', file: 'cline_mcp_settings.json' },
        { name: 'Roo Code', file: 'roo_mcp_settings.json' }
      ];

      for (const { name, file } of vscodeMcpConfigs) {
        const configPath = path.join(vscodeDir, file);
        let vsConfig: any = {};
        if (fs.existsSync(configPath)) {
          try {
            vsConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          } catch (e) {}
        }
        if (!vsConfig.mcpServers) {
          vsConfig.mcpServers = {};
        }
        vsConfig.mcpServers = {
          ...vsConfig.mcpServers,
          ...generated.mcpServers
        };
        fs.writeFileSync(configPath, JSON.stringify(vsConfig, null, 2));
        console.log(`Updated ${name} (VS Code) MCP configuration at ${configPath}`);
      }

      // Generate Codex CLI config if .codex exists
      if (fs.existsSync(path.join(cwd, '.codex'))) {
        const codexConfigPath = path.join(cwd, '.codex', 'config.toml');
        let codexConfig = '';
        if (fs.existsSync(codexConfigPath)) {
          codexConfig = fs.readFileSync(codexConfigPath, 'utf8');
        }
        if (!codexConfig.includes('[mcp_servers.contextos]')) {
          codexConfig += `\n\n[mcp_servers.contextos]\ncommand = "npx"\nargs = ["-y", "@siddharthakatiyar/contextos@latest", "serve"]\n`;
          codexConfig += `[mcp_servers.contextos.env]\nCONTEXTOS_REPO_ROOT = "${cwd}"\nCONTEXTOS_WORKSPACE = ""\n`;
          fs.writeFileSync(codexConfigPath, codexConfig.trim() + '\n');
          console.log(`Updated Codex CLI configuration at ${codexConfigPath}`);
        }
      }

      // Auto-start daemon in background for zero-config DX
      try {
        const { spawn } = await import('child_process');
        const daemonProcess = spawn('npx', ['contextos', 'daemon', 'start'], {
          detached: true,
          stdio: 'ignore'
        });
        daemonProcess.unref();
        console.log('ContextOS daemon started in background (zero-config).');
      } catch (e) {
        console.log('Failed to auto-start daemon, you can run `npx contextos daemon` manually.');
      }

      console.log('ContextOS initialization complete. You can now use the agent!');
    } finally {
      db.close();
    }
  });
