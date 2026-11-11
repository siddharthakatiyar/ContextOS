import { Command } from 'commander';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
export const workspaceCommand = new Command('workspace').description('Manage workspaces');
workspaceCommand
  .command('add <name>')
  .description('Add a workspace')
  .action((name: string) => {
    const registry = new WorkspaceRegistry();
    try {
      registry.ensureWorkspace(name);
      console.log(`Workspace ${name} added.`);
    } finally {
      registry.close();
    }
  });
workspaceCommand
  .command('list')
  .description('List workspaces')
  .action(() => {
    const registry = new WorkspaceRegistry();
    try {
      for (const ws of registry.workspaces())
        console.log(`- ${ws.name} (${registry.list(ws.id).length} repositories)`);
    } finally {
      registry.close();
    }
  });
