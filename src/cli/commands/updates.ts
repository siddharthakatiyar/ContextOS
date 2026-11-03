import os from 'node:os';
import { Command } from 'commander';
import {
  getAutoPatchPolicyPath,
  readAutoPatchPolicy,
  writeAutoPatchPolicy,
  type UpdatePolicyMode
} from '../../core/updater/auto-patch-policy.js';

export const updatesCommand = new Command('updates').description(
  'Manage ContextOS update behavior'
);

updatesCommand
  .command('policy')
  .description('Show or set the per-user update policy')
  .argument('[mode]', 'notify or auto-patch')
  .action((mode?: string) => {
    if (mode !== undefined) {
      if (mode !== 'notify' && mode !== 'auto-patch') {
        throw new Error('Update policy must be either "notify" or "auto-patch".');
      }
      writeAutoPatchPolicy(mode as UpdatePolicyMode);
    }
    const activeMode = readAutoPatchPolicy();
    process.stdout.write(
      `Update policy: ${activeMode}\n` +
        `Settings file: ${getAutoPatchPolicyPath(os.homedir())}\n` +
        (activeMode === 'auto-patch'
          ? 'Automatic installation is enabled by default for stable patch releases in the current major and minor version on Linux global npm installs. Disable it with `contextos updates policy notify`.\n'
          : 'Updates are reported with a command; no package is installed automatically.\n')
    );
  });
