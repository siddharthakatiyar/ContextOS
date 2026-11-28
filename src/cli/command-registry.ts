import type { Command } from 'commander';
/** Add a command module and one loader; keep startup imports lazy. */
export const commandRegistry: readonly (() => Promise<Command>)[] = [
  () => import('./commands/init.js').then((m) => m.initCommand),
  () => import('./commands/setup.js').then((m) => m.setupCommand),
  () => import('./commands/enable.js').then((m) => m.enableCommand),
  () => import('./commands/serve.js').then((m) => m.serveCommand),
  () => import('./commands/query.js').then((m) => m.queryCommand),
  () => import('./commands/workspace.js').then((m) => m.workspaceCommand),
  () => import('./commands/watch.js').then((m) => m.watchCommand),
  () => import('./commands/export.js').then((m) => m.exportCommand),
  () => import('./commands/import.js').then((m) => m.importCommand),
  () => import('./commands/analytics.js').then((m) => m.analyticsCommand),
  () => import('./commands/status.js').then((m) => m.statusCommand),
  () => import('./commands/verify.js').then((m) => m.verifyCommand),
  () => import('./commands/doctor.js').then((m) => m.doctorCommand),
  () => import('./commands/reindex.js').then((m) => m.reindexCommand),
  () => import('./commands/clean.js').then((m) => m.cleanCommand),
  () => import('./commands/daemon.js').then((m) => m.daemonCommand),
  () => import('./commands/visualize.js').then((m) => m.visualizeCommand),
  () => import('./commands/upgrade.js').then((m) => m.upgradeCommand),
  () => import('./commands/updates.js').then((m) => m.updatesCommand),
  () => import('./commands/repo.js').then((m) => m.repoCommand),
  () => import('./commands/group.js').then((m) => m.groupCommand),
  () => import('./commands/worktree.js').then((m) => m.worktreeCommand)
];
export function loadCommands(): Promise<Command[]> {
  return Promise.all(commandRegistry.map((load) => load()));
}
