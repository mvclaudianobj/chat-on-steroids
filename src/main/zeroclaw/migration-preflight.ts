/**
 * Foundation for MarksClaw -> ZeroClaw migration planning.
 *
 * This is deliberately an in-memory preflight for SYNTHETIC inventory only.
 * Neither MarksClaw nor ZeroClaw's on-disk formats have been verified for a
 * safe credentials/memory migration. Never infer migration authority from a
 * reported presence flag. No real profile, CLI, file, vault or OAuth API is
 * accessed here, and no step is executable.
 */
import { z } from 'zod';

const presence = z.enum(['present', 'absent', 'unknown']);
const requestSchema = z.object({
  mode: z.literal('dry-run'),
  evidence: z.literal('synthetic-fixture'),
  source: z.object({
    marksOAuth: presence,
    marksMemory: presence,
    marksProvider: presence
  }).strict(),
  target: z.object({
    zeroClawConfig: presence
  }).strict()
}).strict();

export type ZeroClawMigrationPreflightRequest = z.infer<typeof requestSchema>;
export type MigrationArea = 'target' | 'oauth' | 'memory' | 'provider';
export type MigrationDecision = 'no_change' | 'inspect' | 'manual_authorization' | 'format_review' | 'adapter_review' | 'preserve_target';

export interface MigrationPreflightStep {
  area: MigrationArea;
  decision: MigrationDecision;
  /** Fixed, non-sensitive instruction. This is advice, never a command to execute. */
  explanation: string;
}

export interface ZeroClawMigrationPreflight {
  mode: 'dry-run';
  evidence: 'synthetic-fixture';
  /** Not a declaration that either real installation was inspected. */
  migrationReady: false;
  changesApplied: false;
  steps: MigrationPreflightStep[];
}

/**
 * Reject arbitrary input (including paths, tokens and config values) rather
 * than accidentally including a secret in a report or error. Each presence
 * flag must be supplied by a synthetic test fixture; no discovery takes place.
 */
export function planZeroClawMigration(input: unknown): ZeroClawMigrationPreflight {
  const checked = requestSchema.safeParse(input);
  if (!checked.success) throw new Error('A strict synthetic fixture and explicit dry-run mode are required');
  const { source, target } = checked.data;

  const steps: MigrationPreflightStep[] = [];
  steps.push(target.zeroClawConfig === 'present'
    ? { area: 'target', decision: 'preserve_target', explanation: 'An existing ZeroClaw configuration requires an explicit merge review. Never overwrite it.' }
    : target.zeroClawConfig === 'absent'
      ? { area: 'target', decision: 'no_change', explanation: 'ZeroClaw must be configured through its own reviewed setup before any migration.' }
      : { area: 'target', decision: 'inspect', explanation: 'Confirm the ZeroClaw configuration state before planning changes.' });

  steps.push(source.marksOAuth === 'present'
    ? { area: 'oauth', decision: 'manual_authorization', explanation: 'Marks OAuth exists in the fixture. Reauthorization or a verified secure transfer protocol is required; never copy tokens or credentials.' }
    : source.marksOAuth === 'absent'
      ? { area: 'oauth', decision: 'no_change', explanation: 'No Marks OAuth was declared in this fixture.' }
      : { area: 'oauth', decision: 'inspect', explanation: 'Marks OAuth presence is unknown; verify a secure migration contract before proceeding.' });

  steps.push(source.marksMemory === 'present'
    ? { area: 'memory', decision: 'format_review', explanation: 'Identify Marks memory layout, ZeroClaw import format, backup and duplicate rules with synthetic data before proposing a copy.' }
    : source.marksMemory === 'absent'
      ? { area: 'memory', decision: 'no_change', explanation: 'No Marks memory was declared in this fixture.' }
      : { area: 'memory', decision: 'inspect', explanation: 'Marks memory presence is unknown; do not assume a path or format.' });

  steps.push(source.marksProvider === 'present'
    ? { area: 'provider', decision: 'adapter_review', explanation: 'Confirm whether the Marks provider is supported by ZeroClaw, its configuration schema and its secret-store contract before mapping it.' }
    : source.marksProvider === 'absent'
      ? { area: 'provider', decision: 'no_change', explanation: 'No Marks provider was declared in this fixture.' }
      : { area: 'provider', decision: 'inspect', explanation: 'Marks provider presence is unknown; do not invent a compatible provider identifier.' });

  // Every call yields the same plan for the same fixture; there is no import,
  // automatic authorization, disk mutation or background migration.
  return { mode: 'dry-run', evidence: 'synthetic-fixture', migrationReady: false, changesApplied: false, steps };
}
