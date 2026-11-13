import { Command } from 'commander';
import { WorkspaceRegistry } from '../../core/workspace/registry.js';
import { initializeProject } from './init.js';
import { refreshWorkspaceDaemon } from '../../core/workspace/daemon.js';
import path from 'node:path';

export const groupCommand = new Command('group').description('Organize projects into groups');
groupCommand
  .command('create <name>')
  .description('Create a group')
  .action((name: string) => {
    const registry = new WorkspaceRegistry();
    try {
      registry.ensureWorkspace(name);
      console.log(`Group ${name} created.`);
    } finally {
      registry.close();
    }
  });
groupCommand
  .command('add <group> <path>')
  .description('Add a project, discover worktrees, and index changed content')
  .option('--name <name>', 'Unique project name')
  .option('--no-index', 'Register without indexing')
  .action(async (group: string, input: string, opts: { name?: string; index: boolean }) =>
    initializeProject(path.resolve(input), { ...opts, group, integrations: false })
  );
groupCommand
  .command('remove <group> <project>')
  .description('Remove membership, keeping project indexes and knowledge')
  .action(async (group: string, project: string) => {
    const registry = new WorkspaceRegistry();
    try {
      registry.remove(project, group);
      await refreshWorkspaceDaemon(group);
      console.log(`Removed ${project} from ${group}. Data retained.`);
    } finally {
      registry.close();
    }
  });
groupCommand
  .command('list')
  .description('List groups')
  .action(() => {
    const registry = new WorkspaceRegistry();
    try {
      for (const group of registry.workspaces())
        console.log(`${group.name}\t${registry.list(group.id).length} projects`);
    } finally {
      registry.close();
    }
  });
groupCommand
  .command('show <group>')
  .option('--json', 'Return JSON')
  .description('Show projects and their live worktrees')
  .action((group: string, opts: { json?: boolean }) => {
    const registry = new WorkspaceRegistry();
    try {
      const sources = registry.list(group, true);
      if (opts.json) console.log(JSON.stringify({ group, views: sources }, null, 2));
      else
        for (const view of sources)
          console.log(
            `${view.name}\t${view.branch ?? 'working/detached'}\t${view.rootPath}\t${view.state}`
          );
    } finally {
      registry.close();
    }
  });
