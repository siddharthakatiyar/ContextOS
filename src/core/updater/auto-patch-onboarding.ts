import os from 'node:os';
import {
  markAutoPatchDefaultNoticeShown,
  shouldShowAutoPatchDefaultNotice
} from './auto-patch-policy.js';

export const AUTO_PATCH_DEFAULT_NOTICE =
  '[ContextOS] Automatic patch updates are enabled by default for supported Linux global npm installs; existing user preferences are respected. Only stable patches in the current major and minor version are installed, and updates are skipped while ContextOS clients are active. Disable automatic installs with `contextos updates policy notify`.\n';

/** Write the one-time default-policy notice and remember it in private user state. */
export function showAutoPatchDefaultNotice(
  writeStderr: (message: string) => unknown = (message) => process.stderr.write(message),
  homeDirectory = os.homedir()
): boolean {
  if (!shouldShowAutoPatchDefaultNotice(homeDirectory)) return false;

  writeStderr(AUTO_PATCH_DEFAULT_NOTICE);
  try {
    markAutoPatchDefaultNoticeShown(homeDirectory);
  } catch {
    // A private onboarding marker is best-effort and must not block the CLI.
  }
  return true;
}
