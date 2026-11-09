import { describe, expect, it } from 'vitest';
import { planZeroClawMigration, type ZeroClawMigrationPreflightRequest } from '../src/main/zeroclaw/migration-preflight.js';

const fixture = (): ZeroClawMigrationPreflightRequest => ({
  mode: 'dry-run',
  evidence: 'synthetic-fixture',
  source: { marksOAuth: 'present', marksMemory: 'present', marksProvider: 'present' },
  target: { zeroClawConfig: 'present' }
});

describe('MarksClaw to ZeroClaw synthetic preflight', () => {
  it('reports the four preservation and authorization gates without performing a migration', () => {
    const report = planZeroClawMigration(fixture());
    expect(report).toMatchObject({
      mode: 'dry-run',
      evidence: 'synthetic-fixture',
      migrationReady: false,
      changesApplied: false
    });
    expect(report.steps.map(step => [step.area, step.decision])).toEqual([
      ['target', 'preserve_target'],
      ['oauth', 'manual_authorization'],
      ['memory', 'format_review'],
      ['provider', 'adapter_review']
    ]);
    expect(JSON.stringify(report)).not.toMatch(/credentials[.]json|refresh_token|access_token|secret_value/);
  });

  it('is deterministic and does not modify its fixture, even when every presence is absent', () => {
    const manifest: ZeroClawMigrationPreflightRequest = {
      mode: 'dry-run',
      evidence: 'synthetic-fixture',
      source: { marksOAuth: 'absent', marksMemory: 'absent', marksProvider: 'absent' },
      target: { zeroClawConfig: 'absent' }
    };
    const original = structuredClone(manifest);
    const first = planZeroClawMigration(manifest);
    expect(planZeroClawMigration(manifest)).toEqual(first);
    expect(manifest).toEqual(original);
    expect(first.steps.every(step => step.decision === 'no_change')).toBe(true);
    expect(first.migrationReady).toBe(false);
  });

  it('fails closed on unknown states and refuses to infer credential or memory locations', () => {
    const manifest: ZeroClawMigrationPreflightRequest = {
      mode: 'dry-run',
      evidence: 'synthetic-fixture',
      source: { marksOAuth: 'unknown', marksMemory: 'unknown', marksProvider: 'unknown' },
      target: { zeroClawConfig: 'unknown' }
    };
    expect(planZeroClawMigration(manifest).steps.every(step => step.decision === 'inspect')).toBe(true);
  });

  it('rejects an implicit execution mode, real-profile paths and credential-bearing fields without echoing them', () => {
    const valid = fixture();
    const invalid = [
      { ...valid, mode: 'apply' },
      { ...valid, evidence: 'live-profile' },
      { ...valid, source: { ...valid.source, oauthToken: 'secret_value' } },
      { ...valid, target: { ...valid.target, path: '/home/person/.zeroclaw' } },
      { ...valid, source: { ...valid.source, marksMemory: '/home/person/.marksclaw/memory' } }
    ];
    for (const input of invalid) {
      expect(() => planZeroClawMigration(input)).toThrow('A strict synthetic fixture and explicit dry-run mode are required');
      try { planZeroClawMigration(input); } catch (error) {
        expect(String(error)).not.toMatch(/secret_value|\/home\/person/);
      }
    }
  });
});
