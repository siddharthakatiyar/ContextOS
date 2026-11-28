import os from 'node:os';
import { importInfra } from './index.js';

// Run in a separate process so OS priority changes cannot affect the MCP host.
const [home, viewId] = process.argv.slice(2);
if (home && viewId) {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_LOW);
  } catch {
    /* Best effort on restricted hosts. */
  }
  await importInfra({ scope: { home, viewIds: [viewId] } });
}
