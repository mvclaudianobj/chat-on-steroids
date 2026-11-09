import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { restoreManagedWorktrees } from '../src/main/worktrees/index.js';

it.skipIf(!process.env.MARKS_WORKTREE_DIAG)('diagnoses broker-owned historic worktree markers read-only', async () => {
  const userData = process.env.MARKS_WORKTREE_DIAG!;
  const config = JSON.parse(readFileSync(`${userData}/config.json`, 'utf8'));
  const swarm = JSON.parse(readFileSync(`${userData}/state/swarm.json`, 'utf8'));
  const workers = [...(swarm.activeRuns ?? []), ...(swarm.dormantRuns ?? [])]
    .flatMap((run: { agents: Array<{ info: any }> }) => run.agents ?? [])
    .map((entry: { info: any }) => entry.info)
    .filter((agent: any) => agent?.role === 'worker' && agent.managedWorktree &&
      agent.state === 'sleeping' && agent.revivable && !agent.managedWorktreeCleaned)
    .map((agent: any) => ({ runId: agent.workerAllocationRunId, agentId: agent.id }));
  const result = await restoreManagedWorktrees(config.roots, workers);
  const reasons = result.rejected.map(row => row.error.split(':')[0]);
  console.log('worktree restore diagnosis', {
    owned: workers.length, restored: result.restored.length,
    rejected: result.rejected.length,
    reasons: reasons.reduce((counts: Record<string, number>, reason: string) => {
      counts[reason] = (counts[reason] ?? 0) + 1;
      return counts;
    }, {})
  });
  expect(result.restored.length + result.rejected.length).toBeGreaterThan(0);
});
