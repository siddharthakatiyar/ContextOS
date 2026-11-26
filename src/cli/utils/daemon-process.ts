import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** A PID file alone never authorizes signalling a process (PIDs can be reused). */
export function verifiedDaemonProcess(pid: number, platform = process.platform): boolean {
  try {
    if (pid === process.pid || pid <= 0 || !Number.isSafeInteger(pid)) return false;
    if (platform === 'linux') {
      if (fs.statSync(`/proc/${pid}`).uid !== process.getuid?.()) return false;
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
      if (!args.some((arg, i) => arg === 'daemon' && args[i + 1] === 'start')) return false;
      return args.some((arg) => {
        if (!path.isAbsolute(arg) || !/[/\\]bin[/\\]contextos(?:\.js)?$/.test(arg)) return false;
        let root = path.dirname(arg);
        for (let i = 0; i < 4; i++, root = path.dirname(root)) {
          try {
            if (
              JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name ===
              '@siddharthakatiyar/contextos'
            )
              return true;
          } catch {
            /* The script may be in dist/bin. */
          }
        }
        return false;
      });
    }
    if (platform === 'darwin') {
      const uid = execFileSync('ps', ['-p', String(pid), '-o', 'uid='], {
        encoding: 'utf8',
        timeout: 2000
      }).trim();
      if (Number(uid) !== process.getuid?.()) return false;
      const command = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
        encoding: 'utf8',
        timeout: 2000
      }).trim();
      const scripts = [
        path.resolve(import.meta.dirname, '../../../bin/contextos.js'),
        path.resolve(import.meta.dirname, '../../../dist/bin/contextos.js')
      ];
      return (
        scripts.some((script) => command.includes(' ' + script + ' daemon start')) &&
        /(?:^|\/)node(?:\s|$)/.test(command)
      );
    }
    return false;
  } catch {
    return false;
  }
}
