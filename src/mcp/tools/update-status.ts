import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { checkForUpdates } from '../../core/updater/index.js';

const updateStatusSchema = z.object({
  status: z.enum(['current', 'update_available', 'unknown']),
  packageName: z.string(),
  currentVersion: z.string(),
  latestVersion: z.string().nullable(),
  updateAvailable: z.boolean().nullable(),
  compatible: z.boolean().nullable(),
  checkedAt: z.string(),
  upgradeCommand: z.string().nullable(),
  upgradeNote: z.string(),
  packageUrl: z.string(),
  releasesUrl: z.string()
});

function describeStatus(status: Awaited<ReturnType<typeof checkForUpdates>>): string {
  if (status.status === 'unknown') {
    const latest = status.latestVersion
      ? ` Latest published version: ${status.latestVersion}.`
      : '';
    return `Update status is unknown; the installed version is ${status.currentVersion}.${latest} The npm registry could not provide enough information to compare versions.`;
  }

  if (status.status === 'current') {
    return `ContextOS ${status.currentVersion} is current according to npm (checked ${status.checkedAt}).`;
  }

  const compatibility = status.compatible
    ? 'The latest release is in the same major version.'
    : 'The latest release changes the major version.';
  return `ContextOS ${status.latestVersion} is available; installed version is ${status.currentVersion}. ${compatibility} Run \`${status.upgradeCommand}\` to upgrade. ${status.upgradeNote} Release notes: ${status.releasesUrl}`;
}

export function registerUpdateStatusTool(server: McpServer): void {
  server.registerTool(
    'contextos_update_status',
    {
      title: 'Check ContextOS updates',
      description:
        'Refresh the published ContextOS package version and return installed/latest versions, semver major compatibility, and the exact CLI upgrade command. This reports only and never installs an update. Automatic replacement supports Linux global npm installs; contextos upgrade --dry-run can print a portable manual plan for recognized npm, pnpm, Yarn, and source-checkout installs.',
      inputSchema: {},
      outputSchema: updateStatusSchema
    },
    async () => {
      const status = await checkForUpdates();
      return {
        structuredContent: { ...status },
        content: [{ type: 'text', text: describeStatus(status) }]
      };
    }
  );
}
