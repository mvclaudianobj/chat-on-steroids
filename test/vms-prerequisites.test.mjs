import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkPrerequisites, findExecutable } from '../scripts/vms-prerequisites.mjs';

describe('VM prerequisite doctor', () => {
  it('reports unavailable dependencies without running commands', async () => {
    let called = 0;
    const result = await checkPrerequisites({ env: { PATH: '' }, runner: () => { called++; } });
    assert.equal(called, 0);
    assert.equal(result.ready, false);
    assert.deepEqual(result.checks.map(c => c.id), ['vagrant', 'virtualbox', 'ansible']);
    assert.ok(result.checks.every(c => c.reason === 'not-found'));
    assert.equal(findExecutable('../vagrant', { PATH: '/tmp' }), null);
  });

  it('checks only fixed version commands with shell disabled', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'marks-vm-doctor-'));
    try {
      for (const name of ['vagrant', 'VBoxManage', 'ansible-playbook']) {
        const file = path.join(dir, name);
        await fs.writeFile(file, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      }
      const calls = [];
      const runner = (file, args, options) => {
        calls.push({ file, args, options });
        const child = new EventEmitter();
        queueMicrotask(() => child.emit('close', 0));
        return child;
      };
      const result = await checkPrerequisites({ env: { PATH: dir }, runner });
      assert.equal(result.ready, true);
      assert.equal(calls.length, 3);
      for (const call of calls) {
        assert.equal(call.options.shell, false);
        assert.deepEqual(call.args, ['--version']);
        assert.equal(path.dirname(call.file), dir);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
