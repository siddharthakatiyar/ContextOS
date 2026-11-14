import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MCP_SERVER_INSTRUCTIONS } from '../../mcp/instructions.js';
import {
  AGENT_BLOCK_START,
  AGENT_BLOCK_END,
  appendSection,
  hasAgentsImport,
  rewriteManagedInstructions
} from './agent-instructions.js';

export const GLOBAL_AGENT_NAMES = [
  'codex',
  'claude',
  'grok',
  'opencode',
  'gemini',
  'antigravity',
  'amp',
  'copilot',
  'windsurf',
  'cursor'
] as const;
export type GlobalAgent = (typeof GLOBAL_AGENT_NAMES)[number];
export interface GlobalAgentResult {
  agent: GlobalAgent;
  status: 'updated' | 'unchanged' | 'would-update' | 'not-installed' | 'manual' | 'error';
  files: string[];
  message?: string;
}
export interface GlobalAgentOptions {
  agent?: GlobalAgent;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

const bootstrap = `Installing ContextOS globally does not initialize a project. For a coding task, run \`contextos setup --check --json\` in the project. If it reports the project is not initialized, ask the user once in conversation whether to set it up, including in automatic mode; only with their agreement run \`contextos init --json\`. For already registered projects, follow the reported nextAction to repair missing checkout configuration or readiness. Respect the user's approval policy; do not change client permissions automatically. If ContextOS retrieval tools are unavailable after initialization, inspect \`contextos doctor --client <client> --noninteractive\` and restart the agent or its MCP connection as needed.`;
export function globalInstructionsBlock(): string {
  return `${AGENT_BLOCK_START}\n## ContextOS (managed global instructions v1.1.1)\n\n${bootstrap}\n\n${MCP_SERVER_INSTRUCTIONS}\n${AGENT_BLOCK_END}`;
}

function isExecutable(name: string, env: NodeJS.ProcessEnv): boolean {
  const extensions =
    process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of (env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      try {
        if (fs.statSync(candidate).isFile()) {
          fs.accessSync(candidate, fs.constants.X_OK);
          return true;
        }
      } catch {
        /* absent or not executable */
      }
    }
  }
  return false;
}

function directoryExists(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/** Reject symlinks in every existing component, including dangling destinations. */
function validatePath(file: string): void {
  let current = path.resolve(file);
  while (true) {
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error(`Symlink is not allowed: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function readFile(file: string): string {
  validatePath(file);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

export function enableGlobalAgentInstructions(
  options: GlobalAgentOptions = {}
): GlobalAgentResult[] {
  const env = options.env ?? process.env;
  const home = options.home ?? env.HOME ?? os.homedir();
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  const claude = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const gemini = path.join(home, '.gemini');
  const definitions: Record<
    GlobalAgent,
    { commands: string[]; dirs: string[]; file?: string; claude?: boolean }
  > = {
    codex: { commands: ['codex'], dirs: [codex], file: path.join(codex, 'AGENTS.md') },
    claude: {
      commands: ['claude'],
      dirs: [claude],
      file: path.join(claude, 'AGENTS.md'),
      claude: true
    },
    grok: {
      commands: ['grok'],
      dirs: [path.join(home, '.grok')],
      file: path.join(home, '.grok', 'AGENTS.md')
    },
    opencode: {
      commands: ['opencode'],
      dirs: [path.join(config, 'opencode')],
      file: path.join(config, 'opencode', 'AGENTS.md')
    },
    gemini: { commands: ['gemini'], dirs: [gemini], file: path.join(gemini, 'GEMINI.md') },
    antigravity: {
      commands: ['antigravity', 'agy'],
      dirs: [path.join(home, '.antigravity'), path.join(config, 'Antigravity')],
      file: path.join(gemini, 'GEMINI.md')
    },
    amp: {
      commands: ['amp'],
      dirs: [path.join(home, '.config', 'amp')],
      file: path.join(home, '.config', 'amp', 'AGENTS.md')
    },
    copilot: {
      commands: ['copilot'],
      dirs: [env.COPILOT_HOME || path.join(home, '.copilot')],
      file: path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'copilot-instructions.md')
    },
    windsurf: {
      commands: ['windsurf'],
      dirs: [path.join(home, '.codeium', 'windsurf'), path.join(config, 'Windsurf')],
      file: path.join(home, '.codeium', 'windsurf', 'memories', 'global_rules.md')
    },
    cursor: {
      commands: ['cursor'],
      dirs: [path.join(home, '.cursor'), path.join(config, 'Cursor')]
    }
  };
  const planned = new Map<string, string>();
  const results: GlobalAgentResult[] = [];
  for (const agent of options.agent ? [options.agent] : GLOBAL_AGENT_NAMES) {
    const def = definitions[agent];
    if (!def.commands.some((name) => isExecutable(name, env)) && !def.dirs.some(directoryExists)) {
      results.push({ agent, status: 'not-installed', files: [] });
      continue;
    }
    if (!def.file) {
      results.push({
        agent,
        status: 'manual',
        files: [],
        message: 'Add ContextOS instructions in Cursor Settings → Rules → User Rules.'
      });
      continue;
    }
    const files = [def.file, ...(def.claude ? [path.join(claude, 'CLAUDE.md')] : [])];
    try {
      // Validate and read all destinations before changing any file for this agent.
      const originals = files.map((file) => planned.get(file) ?? readFile(file));
      const updated = [rewriteManagedInstructions(originals[0], globalInstructionsBlock())];
      if (def.claude) {
        let content = rewriteManagedInstructions(originals[1], '');
        if (!hasAgentsImport(content)) content = appendSection(content, '@AGENTS.md');
        updated.push(content);
      }
      const changed = updated.some((content, index) => content !== originals[index]);
      if (changed && !options.dryRun) {
        for (let i = 0; i < files.length; i++) {
          if (updated[i] === originals[i]) continue;
          validatePath(files[i]);
          fs.mkdirSync(path.dirname(files[i]), { recursive: true });
          validatePath(files[i]);
          fs.writeFileSync(files[i], updated[i], { mode: 0o644 });
        }
      }
      files.forEach((file, index) => planned.set(file, updated[index]));
      results.push({
        agent,
        status: changed ? (options.dryRun ? 'would-update' : 'updated') : 'unchanged',
        files
      });
    } catch (error) {
      results.push({
        agent,
        status: 'error',
        files,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return results;
}
