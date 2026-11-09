import { describe, expect, it } from 'vitest';
import { companyLiveSeatState } from '../src/renderer/company-live-presentation.js';
import type { CompanyObservabilityView } from '../src/main/company-observability.js';

const now = 1_000_000;
function observation(state: CompanyObservabilityView['seats'][number]['state'], source: CompanyObservabilityView['seats'][number]['source'], options: { error?: boolean; observedAt?: number | null; at?: number; demo?: boolean } = {}): CompanyObservabilityView {
  return { at: options.at ?? now, demo: options.demo ?? false, events: [], attention: 0, statusCounts: {}, seats: [{ seat: 'marks1', state, source, error: options.error ?? false, observedAt: options.observedAt ?? now, statusSince: now, provenance: 'fixture', ticketId: null, ownerId: null, runId: null, workerId: null, tokensUsed: null, minutesUsed: null }] };
}
describe('Company Board/Office/RPG live seat projection', () => {
  it('never asserts working from a manual ticket or missing broker observation', () => {
    expect(companyLiveSeatState(null, 'marks1', false, now).state).toBe('unverified');
    expect(companyLiveSeatState(observation('working', 'company'), 'marks1', false, now).state).toBe('unverified');
    expect(companyLiveSeatState(observation('working', 'error', { error: true }), 'marks1', false, now).state).toBe('unverified');
    expect(companyLiveSeatState(observation('working', 'broker'), 'marks1', false, now).state).toBe('working');
  });
  it('does not promote stale, demo, missing or mismatched source records to real activity', () => {
    expect(companyLiveSeatState(observation('working', 'broker', { at: now - 91_000, observedAt: now - 91_000 }), 'marks1', false, now).state).toBe('unverified');
    expect(companyLiveSeatState(observation('working', 'broker', { demo: true }), 'marks1', false, now).state).toBe('unverified');
    expect(companyLiveSeatState(observation('working', 'broker'), 'marks1', true, now).state).toBe('unverified');
    expect(companyLiveSeatState(observation('working', 'broker'), 'marks6', false, now).state).toBe('unverified');
    expect(companyLiveSeatState(observation('meeting-present', 'broker'), 'marks1', false, now).state).toBe('unverified');
  });
  it('projects meeting and verified availability from the correct source', () => {
    expect(companyLiveSeatState(observation('meeting-present', 'meeting'), 'marks1', false, now).state).toBe('meeting-present');
    expect(companyLiveSeatState(observation('available-confirmed', 'company'), 'marks1', false, now).state).toBe('available-confirmed');
    expect(companyLiveSeatState(observation('available-confirmed', 'broker'), 'marks1', false, now).state).toBe('unverified');
  });
});
