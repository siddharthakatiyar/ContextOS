import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function checkForUpdates(): Promise<void> {
  try {
    // 1. Get local version
    let localVersion = '0.0.0';
    try {
      let pkgPath = path.join(__dirname, '../../../package.json');
      if (!fs.existsSync(pkgPath)) {
        pkgPath = path.join(__dirname, '../../../../package.json');
      }
      localVersion = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
    } catch {
      // fail silently if we can't find package.json
      return;
    }

    // 2. Fetch latest version from npm
    exec('npm view @siddharthakatiyar/contextos version', (error, stdout) => {
      if (error) {
        // Silently ignore network or npm errors
        return;
      }

      const remoteVersion = stdout.trim();
      if (!remoteVersion) return;

      // 3. Compare versions
      if (isNewerVersion(localVersion, remoteVersion)) {
        process.stderr.write(
          `\n[ContextOS] A new version (${remoteVersion}) is available. Please update by running: npm install -g @siddharthakatiyar/contextos@latest\n`
        );
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
