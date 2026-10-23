import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { companyRoleSchema, companyPresenceSchema, companySeatSchema, companyStateNameSchema } from '../shared/company.js';
import { getCompany, mutateCompany } from './company-store.js';

export const companyIpcSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }).strict(),
  z.object({ action: z.literal('demo') }).strict(),
  z.object({ action: z.literal('configure'), payload: z.object({ name: z.string().trim().min(1).max(100), seatCount: z.number().int().min(1).max(99) }).strict() }).strict(),
  z.object({ action: z.literal('create'), payload: z.object({ title: z.string().trim().min(1).max(160), project: z.string().trim().min(1).max(120), owner: companyRoleSchema, origin: z.union([z.literal('ceo'), companyRoleSchema]), acceptance: z.string().trim().min(1).max(1200), engine: z.string().trim().min(1).max(60), model: z.string().trim().min(1).max(120), tokenBudget: z.number().int().min(0).max(10_000_000), timeBudgetMinutes: z.number().int().min(0).max(525600), dueAt: z.number().int().nonnegative().nullable() }).strict() }).strict(),
  z.object({ action: z.literal('move'), payload: z.object({ id: z.string().uuid(), status: companyStateNameSchema }).strict() }).strict(),
  z.object({ action: z.literal('authorize'), payload: z.object({ id: z.string().uuid(), ownerId: z.string().uuid(), workerId: z.string().regex(/^worker-[1-9][0-9]*$/), runId: z.string().uuid(), consent: z.literal(true) }).strict() }).strict(),
  z.object({ action: z.literal('report'), payload: z.object({ id: z.string().uuid(), workerId: z.string().regex(/^worker-[1-9][0-9]*$/), runId: z.string().uuid(), reportId: z.string().min(1).max(100), result: z.string().trim().min(1).max(1200), evidence: z.string().trim().min(1).max(1200), outcome: z.enum(['completed','failed']) }).strict() }).strict(),
  z.object({ action: z.literal('confirm'), payload: z.object({ id: z.string().uuid(), workerId: z.string().regex(/^worker-[1-9][0-9]*$/), runId: z.string().uuid(), reportId: z.string().trim().min(1).max(100), evidence: z.string().trim().min(1).max(400) }).strict() }).strict(),
  z.object({ action: z.literal('meeting'), payload: z.object({ title: z.string().trim().min(1).max(160), agenda: z.string().trim().min(1).max(2400), durationMinutes: z.number().int().min(1).max(480) }).strict() }).strict(),
  z.object({ action: z.literal('attendance'), payload: z.object({ id: z.string().uuid(), seat: companySeatSchema, state: companyPresenceSchema, contribution: z.string().max(1600), evidence: z.string().min(1).max(400) }).strict() }).strict(),
  z.object({ action: z.literal('minutes'), payload: z.object({ id: z.string().uuid(), minutes: z.string().max(5000), decisions: z.array(z.string().trim().min(1).max(800)).max(30) }).strict() }).strict(),
  z.object({ action: z.literal('seat'), payload: z.object({ id: z.string().uuid(), seat: companySeatSchema.nullable() }).strict() }).strict()
]);
export type CompanyIpcRequest = z.infer<typeof companyIpcSchema>;
export function registerCompanyIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('marksCompany:request', async (event, payload: unknown) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      return { ok: false, error: 'Unauthorized company window' };
    const parsed = companyIpcSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: 'Invalid company request' };
    try {
      if (parsed.data.action === 'authorize' || parsed.data.action === 'report' || parsed.data.action === 'confirm' || parsed.data.action === 'attendance') return { ok: false, error: 'Broker/COO identity and evidence verification are not yet connected; operation refused' };
      const data = parsed.data.action === 'get' ? await getCompany() : await mutateCompany(parsed.data.action, 'payload' in parsed.data ? parsed.data.payload : undefined);
      return { ok: true, data };
    } catch { return { ok: false, error: 'Unable to update company; check seat availability and stored data' }; }
  });
}
