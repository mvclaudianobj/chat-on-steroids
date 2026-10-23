/** Local-only company prototype. It does not control agents or publish memories. */
import { z } from 'zod';

export const COMPANY_ROLES = ['marks-coo', 'marks-cto', 'marks-cio', 'marks-cpo', 'marks-cko', 'marks-cqo', 'marks-cco'] as const;
export const COMPANY_STATES = ['inbox', 'assigned', 'working', 'review', 'needs-ceo', 'done'] as const;
export const COMPANY_AREAS = ['Operations', 'Engineering', 'Infrastructure', 'Product', 'Knowledge', 'Quality', 'Communications'] as const;
export type CompanyRole = typeof COMPANY_ROLES[number];
export type CompanyStateName = typeof COMPANY_STATES[number];
export const companyRoleSchema = z.enum(COMPANY_ROLES);
export const companyStateNameSchema = z.enum(COMPANY_STATES);
export const companySeatSchema = z.string().regex(/^marks(?:[1-9][0-9]?)$/);
const safeText = (limit: number) => z.string().trim().min(1).max(limit);
const tick = z.number().int().min(0);
export const companyPresenceSchema = z.enum(['invited','accepted','declined','present']);
const actor = z.union([z.literal('ceo'), companyRoleSchema, companySeatSchema]);
export const companySchema = z.object({
  name: safeText(100),
  seatCount: z.number().int().min(1).max(99).default(5),
  roles: z.tuple([z.literal('marks-coo'), z.literal('marks-cto'), z.literal('marks-cio'), z.literal('marks-cpo'), z.literal('marks-cko'), z.literal('marks-cqo'), z.literal('marks-cco')]),
  seats: z.array(companySeatSchema).min(1).max(99)
}).strict().superRefine((data, context) => {
  if (data.seats.length !== data.seatCount || data.seats.some((seat, index) => seat !== `marks${index + 1}`))
    context.addIssue({ code: 'custom', path: ['seats'], message: 'Seats must be marks1..N' });
});
export const companyHistorySchema = z.object({ at: tick, actor, note: safeText(400), from: companyStateNameSchema.optional(), to: companyStateNameSchema.optional() }).strict();
export const companyRequestSchema = z.object({
  id: z.string().uuid(), title: safeText(160), project: safeText(120), origin: z.union([z.literal('ceo'), companyRoleSchema]),
  owner: companyRoleSchema, seat: companySeatSchema.nullable(), engine: safeText(60), model: safeText(120),
  acceptance: safeText(1200), tokenBudget: z.number().int().min(0).max(10_000_000), timeBudgetMinutes: z.number().int().min(0).max(525600),
  tokensUsed: z.number().int().min(0).max(10_000_000), minutesUsed: z.number().int().min(0).max(525600),
  dueAt: tick.nullable(), status: companyStateNameSchema,
  raci: z.object({ responsible: actor, accountable: actor, consulted: z.array(actor).max(20), informed: z.array(actor).max(20) }).strict(),
  execution: z.object({ mode: z.enum(['simulated','live']), phase: z.enum(['awaiting-authorization','admitted','running','reported','failed']), ownerId: z.string().uuid().nullable(), workerId: z.string().regex(/^worker-[1-9][0-9]*$/).nullable(), runId: z.string().uuid().nullable(), reportId: z.string().max(100).nullable(), result: z.string().max(1200).nullable(), evidence: z.string().max(1200).nullable(), authorizedAt: tick.nullable() }).strict().optional(),
  history: z.array(companyHistorySchema).max(300), createdAt: tick, updatedAt: tick
}).strict();
export const companyMeetingSchema = z.object({
  id: z.string().uuid(), title: safeText(160), participants: z.array(actor).min(2).max(101),
  invitations: z.array(z.object({ seat: companySeatSchema, state: companyPresenceSchema, contribution: z.string().max(1600), confirmedAt: tick.nullable(), evidence: z.string().max(400).nullable() }).strict()).max(99).optional(), agenda: z.string().max(2400).optional(),
  at: tick, durationMinutes: z.number().int().min(1).max(480), minutes: z.string().max(5000),
  decisions: z.array(safeText(800)).max(30), brainSync: z.literal('pending')
}).strict();
export const companyActivitySchema = z.object({ id: z.string().uuid(), at: tick, actor, kind: z.enum(['request', 'move', 'seat', 'meeting', 'company']), requestId: z.string().uuid().optional(), message: safeText(400) }).strict();
export const companySnapshotSchema = z.object({ version: z.literal(1), company: companySchema, requests: z.array(companyRequestSchema).max(500), meetings: z.array(companyMeetingSchema).max(150), activities: z.array(companyActivitySchema).max(1000), demo: z.boolean() }).strict().superRefine((data, context) => {
  const ids = new Set<string>();
  for (const [index, request] of data.requests.entries()) {
    if (ids.has(request.id)) context.addIssue({ code: 'custom', path: ['requests', index, 'id'], message: 'Duplicate request' });
    ids.add(request.id);
    if (request.seat && !data.company.seats.includes(request.seat)) context.addIssue({ code: 'custom', path: ['requests', index, 'seat'], message: 'Seat not in company' });
    if ((request.status === 'assigned' || request.status === 'working' || request.status === 'review') && !request.seat)
      context.addIssue({ code: 'custom', path: ['requests', index, 'seat'], message: 'Assigned work requires a seat' });
  }
});
export type Company = z.infer<typeof companySchema>;
export type CompanyRequest = z.infer<typeof companyRequestSchema>;
export type CompanyMeeting = z.infer<typeof companyMeetingSchema>;
export type ActivityEvent = z.infer<typeof companyActivitySchema>;
export type CompanySnapshot = z.infer<typeof companySnapshotSchema>;

export function emptyCompany(): CompanySnapshot {
  return { version: 1, company: { name: 'Chat Marks', seatCount: 5, roles: [...COMPANY_ROLES], seats: companySeats(5) }, requests: [], meetings: [], activities: [], demo: false };
}
export function companySeats(count: number): string[] { return Array.from({ length: count }, (_, i) => `marks${i + 1}`); }

/** Clearly marked synthetic records for visual review; no real sessions or costs. */
export function demoCompany(now = Date.now()): CompanySnapshot {
  const snapshot = emptyCompany();
  snapshot.company.name = 'Marks Studio';
  snapshot.demo = true;
  const titles = [
    ['Review the product roadmap', 'Studio / Product', 'marks-cpo', 'marks1', 'codex', 'gpt-6', 'inbox', 8200, 0],
    ['Update the landing page', 'Website', 'marks-cto', 'marks2', 'claude', 'sonnet', 'assigned', 12000, 250],
    ['Audit service health', 'Platform', 'marks-cio', 'marks3', 'opencode', 'free', 'working', 20000, 6200],
    ['Improve onboarding flows', 'Experience', 'marks-cpo', 'marks1', 'chatgpt', 'gpt-6', 'review', 14000, 9500],
    ['Choose release priority', 'Studio / Product', 'marks-coo', 'marks4', 'claude', 'sonnet', 'needs-ceo', 4000, 1900],
    ['Organize knowledge index', 'Knowledge', 'marks-cko', 'marks5', 'codex', 'gpt-6', 'done', 12000, 10400],
    ['Check accessibility', 'Quality', 'marks-cqo', 'marks2', 'opencode', 'free', 'working', 7500, 3200],
    ['Write stakeholder brief', 'Communication', 'marks-cco', 'marks4', 'chatgpt', 'gpt-6', 'review', 3000, 1400]
  ] as const;
  snapshot.requests = titles.map(([title, project, owner, seat, engine, model, status, tokenBudget, tokensUsed], index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, title, project, origin: index % 3 === 0 ? 'ceo' : 'marks-coo',
    owner, seat: status === 'inbox' ? null : seat, engine, model, acceptance: 'Deliver a concise, reviewable result with evidence and next steps.',
    tokenBudget, timeBudgetMinutes: 120, tokensUsed, minutesUsed: Math.round(tokensUsed / 140),
    dueAt: now + (index - 2) * 86_400_000, status, raci: { responsible: status === 'inbox' ? owner : seat, accountable: 'ceo', consulted: ['marks-cqo'], informed: ['marks-coo'] },
    history: [{ at: now - (10 - index) * 3_600_000, actor: 'ceo', note: 'Synthetic request created.' }], createdAt: now - (10 - index) * 3_600_000, updatedAt: now - index * 1_800_000
  }));
  snapshot.meetings = [{ id: '00000000-0000-4000-8000-000000000101', title: 'Weekly leadership sync', participants: ['ceo', 'marks-coo', 'marks-cto', 'marks-cpo'], at: now - 86_400_000, durationMinutes: 25, minutes: 'Demo: priorities reviewed and responsibilities confirmed.', decisions: ['Review launch priorities with the CEO.', 'Keep quality checks in the review stage.'], brainSync: 'pending' }];
  snapshot.activities = snapshot.requests.map((request, index) => ({ id: `00000000-0000-4000-8000-${String(index + 201).padStart(12, '0')}`, at: request.updatedAt, actor: request.owner, kind: 'request' as const, requestId: request.id, message: `${request.title} · ${request.status}` })).sort((a,b) => b.at - a.at);
  return companySnapshotSchema.parse(snapshot);
}
