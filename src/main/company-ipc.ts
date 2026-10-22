import { ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { companyRoleSchema, companySeatSchema, companyStateNameSchema } from '../shared/company.js';
import { getCompany, mutateCompany } from './company-store.js';

export const companyIpcSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }).strict(),
  z.object({ action: z.literal('demo') }).strict(),
  z.object({ action: z.literal('configure'), payload: z.object({ name: z.string().trim().min(1).max(100), seatCount: z.number().int().min(1).max(50) }).strict() }).strict(),
  z.object({ action: z.literal('create'), payload: z.object({ title: z.string().trim().min(1).max(160), project: z.string().trim().min(1).max(120), owner: companyRoleSchema, origin: z.union([z.literal('ceo'), companyRoleSchema]), acceptance: z.string().trim().min(1).max(1200), engine: z.string().trim().min(1).max(60), model: z.string().trim().min(1).max(120), tokenBudget: z.number().int().min(0).max(10_000_000), timeBudgetMinutes: z.number().int().min(0).max(525600), dueAt: z.number().int().nonnegative().nullable() }).strict() }).strict(),
  z.object({ action: z.literal('move'), payload: z.object({ id: z.string().uuid(), status: companyStateNameSchema }).strict() }).strict(),
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
      const data = parsed.data.action === 'get' ? await getCompany() : await mutateCompany(parsed.data.action, 'payload' in parsed.data ? parsed.data.payload : undefined);
      return { ok: true, data };
    } catch { return { ok: false, error: 'Unable to update company; check seat availability and stored data' }; }
  });
}
