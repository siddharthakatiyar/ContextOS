import { exec, spawn } from 'child_process';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

export async function checkForUpdates(): Promise<void> {
  try {
    // 1. Get local version
    let localVersion = '0.0.0';
    try {
      localVersion = require("../../../package.json").version;
    } catch {
      try {
        localVersion = require("../../../../package.json").version;
      } catch {
        // fail silently if we can't find package.json
        return;
      }
    }

    // 2. Fetch latest version from npm
    exec('npm view @siddharthakatiyar/contextos version', (error, stdout) => {
      if (error) {
        // Silently ignore network or npm errors
        return;
      }

      const remoteVersion = stdout.trim();
      if (!remoteVersion) return;

      // 3. Compare versions (simple string comparison works for major.minor.patch if padded, but better to use simple split)
      if (isNewerVersion(localVersion, remoteVersion)) {
        process.stderr.write(`\n[ContextOS] A new version (${remoteVersion}) is available. Auto-updating in background...\n`);

        // 4. Spawn detached npm install
        const child = spawn('npm', ['install', '-g', '@siddharthakatiyar/contextos@latest'], {
          detached: true,
          stdio: 'ignore'
        });
        
        // Unref the child process so it doesn't prevent the parent from exiting
        child.unref();
      }
    });
  } catch (error) {
    // Top level catch to ensure we never crash the MCP server
  }
}

function isNewerVersion(local: string, remote: string): boolean {
  const parseVersion = (v: string) => v.replace(/^v/, '').split('.').map(Number);
  const [lMajor, lMinor, lPatch] = parseVersion(local);
  const [rMajor, rMinor, rPatch] = parseVersion(remote);

  if (rMajor > lMajor) return true;
  if (rMajor < lMajor) return false;
  
  if (rMinor > lMinor) return true;
  if (rMinor < lMinor) return false;
  
  if (rPatch > lPatch) return true;
  return false;
}
