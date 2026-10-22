import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Read-only host prerequisites. Never launches a VM or reads its configuration.
const CHECKS = Object.freeze([
  { id: 'vagrant', command: 'vagrant', args: ['--version'], required: true },
  { id: 'virtualbox', command: 'VBoxManage', args: ['--version'], required: true },
  { id: 'ansible', command: 'ansible-playbook', args: ['--version'], required: true }
]);

export function findExecutable(command, env = process.env, platform = process.platform) {
  const pathValue = env.PATH;
  if (!pathValue || /[/\\]/.test(command)) return null;
  const extensions = platform === 'win32'
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(ext => ext.toLowerCase())
    : [''];
  for (const folder of pathValue.split(path.delimiter)) {
    if (!folder || !path.isAbsolute(folder)) continue;
    for (const extension of extensions) {
      const candidate = path.join(folder, platform === 'win32' ? command + extension : command);
      try {
        const stat = fs.statSync(candidate);
        if (stat.isFile() && (platform === 'win32' || (stat.mode & 0o111))) return candidate;
      } catch { /* Continue checking other PATH entries. */ }
    }
  }
  return null;
}

export async function checkPrerequisites({ env = process.env, platform = process.platform, runner = spawn } = {}) {
  const results = [];
  for (const check of CHECKS) {
    const executable = findExecutable(check.command, env, platform);
    if (!executable) {
      results.push({ id: check.id, available: false, reason: 'not-found' });
      continue;
    }
    const result = await new Promise(resolve => {
      let settled = false;
      const done = (available, reason) => {
        if (settled) return;
        settled = true;
        resolve({ id: check.id, available, ...(reason ? { reason } : {}) });
      };
      let child;
      try {
        child = runner(executable, check.args, { shell: false, stdio: 'ignore', env, windowsHide: true });
      } catch {
        done(false, 'spawn-failed');
        return;
      }
      child.once('error', () => done(false, 'spawn-failed'));
      child.once('close', code => done(code === 0, code === 0 ? null : 'version-check-failed'));
    });
    results.push(result);
  }
  return { ready: results.every(result => result.available), checks: results };
}
