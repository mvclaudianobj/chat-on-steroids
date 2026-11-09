import { describe, expect, it } from 'vitest';
import { orphanWorkerTurnEligible, WORKER_ORPHAN_MIN_AGE_MS } from '../src/main/worker-cleanup.js';

describe('explicit worker cleanup orphan fence', () => {
  const now = 1_000_000;
  const old = now - WORKER_ORPHAN_MIN_AGE_MS - 1;
  it('permits the exact old recorded turn when no page, tool or approval can control it', () => {
    expect(orphanWorkerTurnEligible({ activeTurnId: 'orphan', updatedAt: old }, {
      activeTurnId: null, heldTurnId: null, pageless: true
    }, { possible: false }, false, now)).toBe(true);
  });
  it('refuses fresh turns and every possible live owner', () => {
    const summary = { activeTurnId: 'turn', updatedAt: old };
    const controls = { activeTurnId: null, heldTurnId: null, pageless: true };
    expect(orphanWorkerTurnEligible({ ...summary, updatedAt: now }, controls, { possible: false }, false, now)).toBe(false);
    expect(orphanWorkerTurnEligible(summary, { ...controls, activeTurnId: 'turn' }, { possible: false }, false, now)).toBe(false);
    expect(orphanWorkerTurnEligible(summary, { ...controls, heldTurnId: 'turn' }, { possible: false }, false, now)).toBe(false);
    expect(orphanWorkerTurnEligible(summary, controls, { possible: true }, false, now)).toBe(false);
    expect(orphanWorkerTurnEligible(summary, controls, { possible: false }, true, now)).toBe(false);
    expect(orphanWorkerTurnEligible({ ...summary, lastToolCallAt: now }, controls, { possible: false }, false, now)).toBe(false);
    expect(orphanWorkerTurnEligible({ ...summary, activeTurnId: null }, controls, { possible: false }, false, now)).toBe(false);
  });
});
