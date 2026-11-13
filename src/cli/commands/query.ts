import { Command } from 'commander';

export const queryCommand = new Command('query')
  .description('Test the retrieval engine with a prompt')
  .argument('<prompt>', 'The user prompt to test')
  .option('--repo <repo...>', 'Search selected repositories (project alias)')
  .option('--project <project...>', 'Search selected projects')
  .option('--group <name>', 'Search a group')
  .option('--branch <branch>', 'Select a live branch')
  .option('--worktree <worktree>', 'Select a worktree by ID or path')
  .option('--all-worktrees', 'Search every live worktree in the selected scope')
  .option('--workspace <name>', 'Search members of a workspace')
  .option('--all-repos', 'Search all members of the default workspace')
  .option('--max-tokens <number>', 'Compiled context token budget')
  .option('--json', 'Output results in JSON format')
  .option('--explain', 'Show retrieval ranking provenance and compilation choices')
  .action(
    async (
      prompt: string,
      options: {
        project?: string[];
        group?: string;
        branch?: string;
        worktree?: string;
        allWorktrees?: boolean;
        json?: boolean;
        explain?: boolean;
        repo?: string[];
        workspace?: string;
        allRepos?: boolean;
        maxTokens?: string;
      }
    ) => {
      const { workspaceQuery } = await import('./workspace-query.js');
      await workspaceQuery(prompt, options);
      return;
    }
  );
