import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { DB, getContextOSHome } from '../../core/storage/database.js';
import { generateCursorConfig } from '../../mcp/cursor/config-generator.js';
import { MCP_SERVER_INSTRUCTIONS } from '../../mcp/instructions.js';
import chalk from 'chalk';
import { mergeContextosMcpConfig, validateJsonConfigs } from '../utils/mcp-config.js';

export const initCommand = new Command('init')
  .description('Initialize ContextOS in the current repository')
  .action(async () => {
    const cwd = process.cwd();
    const repoContextDir = path.join(cwd, '.contextos');
    const globalContextDir = path.join(getContextOSHome(), 'global');
    const homeDir = process.env.HOME || process.env.USERPROFILE || '';
    const antigravityGlobalPath = homeDir
      ? path.join(homeDir, '.gemini', 'config', 'mcp_config.json')
      : null;
    const jsonConfigPaths = [
      fs.existsSync(path.join(cwd, '.cursor')) ? path.join(cwd, '.cursor', 'mcp.json') : null,
      antigravityGlobalPath,
      fs.existsSync(path.join(cwd, '.agents'))
        ? path.join(cwd, '.agents', 'mcp_config.json')
        : null,
      path.join(cwd, '.mcp.json'),
      path.join(cwd, '.vscode', 'cline_mcp_settings.json'),
      path.join(cwd, '.vscode', 'roo_mcp_settings.json')
    ].filter((configPath): configPath is string => configPath !== null);

    // Fail before writing any client configuration or starting the daemon. An
    // invalid existing config must never be silently replaced.
    validateJsonConfigs(jsonConfigPaths);

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

    try {
      const startTime = Date.now();

      // Mark repo as needing a full index so the daemon will pick it up
      const statusPath = path.join(repoContextDir, 'status.json');
      fs.writeFileSync(statusPath, JSON.stringify({ fullIndexCompleted: false }));

      const elapsedMs = Date.now() - startTime;
      console.log(
        chalk.green.bold(`\n\u2714 Initialized ContextOS in ${(elapsedMs / 1000).toFixed(1)}s`)
      );
      console.log(`Repository is scheduled for background indexing.\n`);

      // Generate cursor config if .cursor exists
      if (fs.existsSync(path.join(cwd, '.cursor'))) {
        const configPath = path.join(cwd, '.cursor', 'mcp.json');
        const result = mergeContextosMcpConfig(
          configPath,
          generateCursorConfig({ projectRoot: cwd })
        );
        console.log(
          `${result === 'preserved' ? 'Preserved' : 'Updated'} Cursor MCP configuration at ${configPath}`
        );
      }

      // Generate Antigravity MCP config
      // 1. Global config: ~/.gemini/config/mcp_config.json (always written)
      if (antigravityGlobalPath) {
        const result = mergeContextosMcpConfig(
          antigravityGlobalPath,
          generateCursorConfig({ projectRoot: cwd })
        );
        console.log(
          `${result === 'preserved' ? 'Preserved' : 'Updated'} Antigravity global MCP configuration at ${antigravityGlobalPath}`
        );
      }

      // 2. Project-level config: .agents/mcp_config.json (if .agents dir exists)
      if (fs.existsSync(path.join(cwd, '.agents'))) {
        const configPath = path.join(cwd, '.agents', 'mcp_config.json');
        const result = mergeContextosMcpConfig(
          configPath,
          generateCursorConfig({ projectRoot: cwd })
        );
        console.log(
          `${result === 'preserved' ? 'Preserved' : 'Updated'} Antigravity project MCP configuration at ${configPath}`
        );
      }

      // Generate Claude Code (and generic) MCP config (.mcp.json)
      const claudeConfigPath = path.join(cwd, '.mcp.json');
      const generated = generateCursorConfig({ projectRoot: cwd });
      const claudeResult = mergeContextosMcpConfig(claudeConfigPath, generated);
      console.log(
        `${claudeResult === 'preserved' ? 'Preserved' : 'Updated'} Claude Code MCP configuration at ${claudeConfigPath}`
      );

      // Ensure CLAUDE.md has instructions since Claude Code currently ignores MCP SDK instructions
      const claudeMdPath = path.join(cwd, 'CLAUDE.md');
      const claudeMdInstructions = `\n## ContextOS\n${MCP_SERVER_INSTRUCTIONS}\n`;
      if (!fs.existsSync(claudeMdPath)) {
        fs.writeFileSync(claudeMdPath, claudeMdInstructions.trim() + '\n');
        console.log(`Created CLAUDE.md with ContextOS instructions`);
      } else {
        const currentClaudeMd = fs.readFileSync(claudeMdPath, 'utf8');
        if (!currentClaudeMd.includes('get_context')) {
          fs.appendFileSync(claudeMdPath, claudeMdInstructions);
          console.log(`Appended ContextOS instructions to CLAUDE.md`);
        }
      }

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
        const result = mergeContextosMcpConfig(configPath, generated);
        console.log(
          `${result === 'preserved' ? 'Preserved' : 'Updated'} ${name} (VS Code) MCP configuration at ${configPath}`
        );
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
        // Use the current process's executable and script to start the daemon,
        // rather than 'npx contextos' which would fetch from npm in CI environments.
        const cliPath = process.argv[1];
        const daemonProcess = spawn(process.execPath, [cliPath, 'daemon', 'start'], {
          detached: true,
          stdio: 'ignore'
        });
        daemonProcess.unref();
        console.log('ContextOS daemon started in background (zero-config).');
      } catch {
        console.log('Failed to auto-start daemon, you can run `npx contextos daemon` manually.');
      }

      console.log('ContextOS initialization complete. You can now use the agent!');
    } finally {
      db.close();
    }
  });
