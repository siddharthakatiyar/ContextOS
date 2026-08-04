import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { getContextOSHome } from '../../core/storage/database.js';

interface WorkspaceConfig {
  name: string;
  repos: string[];
  contextDir: string;
}

export const workspaceCommand = new Command('workspace').description('Manage workspaces');

workspaceCommand
  .command('add <name>')
  .description('Add a workspace')
  .action((name: string) => {
    const configPath = path.join(getContextOSHome(), 'workspaces.json');
    let workspaces: Record<string, WorkspaceConfig> = {};
    if (fs.existsSync(configPath)) {
      workspaces = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
    workspaces[name] = {
      name,
      repos: [],
      contextDir: path.join(getContextOSHome(), 'workspaces', name)
    };
    fs.writeFileSync(configPath, JSON.stringify(workspaces, null, 2));
    console.log(`Workspace ${name} added.`);
  });

workspaceCommand
  .command('list')
  .description('List workspaces')
  .action(() => {
    const configPath = path.join(getContextOSHome(), 'workspaces.json');
    if (!fs.existsSync(configPath)) {
      console.log('No workspaces found.');
      return;
    }
    const workspaces = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('Workspaces:');
    for (const name of Object.keys(workspaces)) {
      console.log(`- ${name}`);
    }
  });
