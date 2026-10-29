import { describe, expect, it, vi } from 'vitest';
import { ApprovalGate } from '../src/main/agent-engine/approval.js';

const request = {
  turnId: 'turn-1', toolCallId: 'call-1', tool: 'exec_command', summary: 'Run a local check',
  action: { command: 'git status --short', cwd: '/tmp/synthetic' }, engineRequestId: 'rpc-1'
};

describe('engine approval retransmission', () => {
  it('shows just one card for a repeated identical pending request and resolves both listeners once', async () => {
    const changed = vi.fn();
    const gate = new ApprovalGate(changed);
    const first = gate.request(request);
    const card = gate.view();
    const second = gate.request({ ...request, action: { cwd: '/tmp/synthetic', command: 'git status --short' } });
    expect(gate.view()?.approvalId).toBe(card?.approvalId);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(gate.answer(card!.approvalId, 'approve')).toBe(true);
    expect(await Promise.all([first, second])).toEqual(['approve', 'approve']);
    expect(gate.answer(card!.approvalId, 'approve')).toBe(false);
  });

  it('returns an already explicit denial for the exact retransmitted request, never creating a new prompt', async () => {
    const gate = new ApprovalGate();
    const first = gate.request(request);
    const card = gate.view()!;
    expect(gate.answer(card.approvalId, 'deny')).toBe(true);
    expect(await first).toBe('deny');
    expect(await gate.request(request)).toBe('deny');
    expect(gate.view()).toBeNull();
  });

  it('does not reuse a prior approval when the command or session identity changed', async () => {
    const gate = new ApprovalGate();
    const first = gate.request(request);
    const oldId = gate.view()!.approvalId;
    gate.answer(oldId, 'always');
    await first;
    const changed = gate.request({ ...request, action: { command: 'rm -rf fake', cwd: '/tmp/synthetic' } });
    const current = gate.view()!;
    expect(current.approvalId).not.toBe(oldId);
    expect(gate.answer(current.approvalId, 'deny')).toBe(true);
    expect(await changed).toBe('deny');
    const nextTurn = gate.request({ ...request, turnId: 'turn-2' });
    expect(gate.view()?.turnId).toBe('turn-2');
    gate.stop();
    expect(await nextTurn).toBe('stop');
  });
});
