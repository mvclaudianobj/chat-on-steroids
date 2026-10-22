#!/usr/bin/env node
import { createLab, defaultLabRoot, executeLab, listLabs } from './vms-lab-core.mjs';

function usage() {
  return [
    'Chat Marks VM lab (item N, independent preview)',
    '  node scripts/marks-vms.mjs init <name> [--root ABSOLUTE_PATH] [--box BOX] [--memory MIB] [--cpus N]',
    '  node scripts/marks-vms.mjs list [--root ABSOLUTE_PATH]',
    '  node scripts/marks-vms.mjs status|up|halt|provision <name> [--root ABSOLUTE_PATH] [--dry-run]',
    '  node scripts/marks-vms.mjs destroy <name> --confirm-destroy <name> [--root ABSOLUTE_PATH] [--dry-run]',
    '  Default root: ' + defaultLabRoot(),
    '  Requires Vagrant + VirtualBox; Ansible is required for provisioning on the host.'
  ].join('\n');
}

export function parseArgs(argv) {
  const [command, ...tail] = argv;
  if (command === 'help' || command === '--help' || !command) return { command: 'help' };
  if (!['init', 'list', 'status', 'up', 'halt', 'provision', 'destroy'].includes(command)) {
    throw new Error('Unknown command: ' + command);
  }
  const options = {};
  if (command !== 'list') {
    const name = tail.shift();
    if (!name || name.startsWith('--')) throw new Error('A VM name is required.');
    options.name = name;
  }
  const allowed = command === 'init'
    ? new Set(['--root', '--box', '--memory', '--cpus'])
    : command === 'list' ? new Set(['--root'])
      : new Set(['--root', '--dry-run', ...(command === 'destroy' ? ['--confirm-destroy'] : [])]);
  while (tail.length) {
    const key = tail.shift();
    if (!allowed.has(key) || Object.hasOwn(options, key)) throw new Error('Unknown or repeated option: ' + key);
    if (key === '--dry-run') {
      options.dryRun = true;
      options[key] = true;
      continue;
    }
    const value = tail.shift();
    if (!value || value.startsWith('--')) throw new Error('Missing value for ' + key);
    if (key === '--root') options.root = value;
    if (key === '--box') options.box = value;
    if (key === '--memory') options.memory = Number(value);
    if (key === '--cpus') options.cpus = Number(value);
    if (key === '--confirm-destroy') options.confirmation = value;
    options[key] = true;
  }
  return { command, options };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs(argv);
  if (command === 'help') {
    process.stdout.write(usage() + '\n');
    return;
  }
  if (command === 'init') {
    const result = await createLab(options);
    process.stdout.write('VM lab created: ' + result.directory + '\n');
    return;
  }
  if (command === 'list') {
    const labs = await listLabs(options);
    for (const item of labs) process.stdout.write(item.name + '  ' + (item.valid ? item.box : 'INVALID (inspect manually)') + '\n');
    if (!labs.length) process.stdout.write('No VM labs found.\n');
    return;
  }
  const result = await executeLab({ ...options, action: command });
  if (result.dryRun) process.stdout.write('DRY RUN: ' + result.command + ' ' + result.args.join(' ') + ' (cwd: ' + result.cwd + ')\n');
}

if (process.argv[1] && import.meta.url === new URL('file://' + process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write('VM lab: ' + error.message + '\n');
    process.exitCode = 1;
  });
}
