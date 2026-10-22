import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLab, executeLab, listLabs, openLab, validateLabName } from '../scripts/vms-lab-core.mjs';

const roots = [];
async function root() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marks-vms-test-'));
  roots.push(dir);
  return dir;
}
afterEach(async () => {
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('isolated VM labs', () => {
  it('creates non-secret config and refuses overwrite', async () => {
    const base = await root();
    const result = await createLab({ name: 'lab-one', root: base });
    assert.match(await fs.readFile(path.join(result.directory, 'Vagrantfile'), 'utf8'), /synced_folder.*disabled: true/);
    assert.match(await fs.readFile(path.join(result.directory, 'site.yml'), 'utf8'), /ansible.builtin.ping/);
    assert.deepEqual((await listLabs({ root: base })).map(l => l.name), ['lab-one']);
    await assert.rejects(createLab({ name: 'lab-one', root: base }));
    await openLab({ name: 'lab-one', root: base });
  });
  it('rejects traversal, invalid resources and symlink roots', async () => {
    const base = await root();
    assert.throws(() => validateLabName('../other'));
    await assert.rejects(createLab({ name: 'x', root: base, box: 'x\\";system(\\"id\\")' }));
    await assert.rejects(createLab({ name: 'x', root: base, memory: 0 }));
    const link = base + '-link';
    await fs.symlink(base, link);
    roots.push(link);
    await assert.rejects(createLab({ name: 'x', root: link }), /symlink/);
  });
  it('refuses edited templates and requires destroy confirmation', async () => {
    const base = await root();
    const { directory } = await createLab({ name: 'demo', root: base });
    await assert.rejects(executeLab({ name: 'demo', root: base, action: 'destroy', dryRun: true }), /confirm-destroy/);
    const plan = await executeLab({ name: 'demo', root: base, action: 'destroy', confirmation: 'demo', dryRun: true });
    assert.deepEqual(plan.args, ['destroy', '--force']);
    await fs.appendFile(path.join(directory, 'site.yml'), 'malicious: true\n');
    await assert.rejects(openLab({ name: 'demo', root: base }), /changed/);
  });
  it('uses fixed argv, no shell, and strips Vagrant overrides', async () => {
    const base = await root();
    await createLab({ name: 'demo', root: base });
    let seen;
    const runner = (bin, args, options) => {
      seen = { bin, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    };
    const old = process.env.VAGRANT_CWD;
    process.env.VAGRANT_CWD = '/outside';
    try {
      await executeLab({ name: 'demo', root: base, action: 'status', runner });
      assert.equal(seen.bin, 'vagrant');
      assert.equal(seen.options.shell, false);
      assert.equal(seen.options.env.VAGRANT_CWD, undefined);
    } finally {
      if (old === undefined) delete process.env.VAGRANT_CWD;
      else process.env.VAGRANT_CWD = old;
    }
  });
});
