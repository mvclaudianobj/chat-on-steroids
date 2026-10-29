/** Shared, conservative seat projection for Board, Office and RPG.
 * Local assignments are workflow records, not proof of an active worker.
 * A broker observation proves only what that broker reported: its external
 * identity must still be attested independently before any privileged grant. */
import type { CompanyObservabilityView } from '../main/company-observability.js';
export type CompanyVisibleSeatState = CompanyObservabilityView['seats'][number]['state'];
export function companyLiveSeatState(view: CompanyObservabilityView | null, seat: string, demo: boolean, now = Date.now()):
  { state: CompanyVisibleSeatState; source: string } {
  const unknown = { state: 'unverified' as const, source: 'unverified' };
  if (!view || demo || view.demo || !Number.isFinite(view.at) || view.at > now + 5000 || now - view.at > 90_000) return unknown;
  const row = view.seats.find(item => item.seat === seat);
  if (!row || row.error) return unknown;
  if (row.state === 'working' || row.state === 'shell-wait') {
    if (row.source !== 'broker' || row.observedAt === null || row.observedAt > now + 5000 || now - row.observedAt > 90_000) return unknown;
  }
  if (row.state === 'meeting-present' && row.source !== 'meeting') return unknown;
  if (row.state === 'available-confirmed' && row.source !== 'company') return unknown;
  if (['needs-ceo', 'review'].includes(row.state) && row.source !== 'company') return unknown;
  return { state: row.state, source: row.source };
}
