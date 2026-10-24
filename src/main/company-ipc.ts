import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { z } from 'zod';
import { companyRoleSchema, companyPresenceSchema, companySeatSchema, companyStateNameSchema, companyMeetingKindSchema, companyChiefSchema, companyDelegationScopeSchema, companyChiefTitleSchema } from '../shared/company.js';
import { activateRealCompany, restoreDemoCompany, getCompany, mutateCompany } from './company-store.js';
import { createCompanyBroker } from './company-broker.js';
import { createCompanyObserver } from './company-observability.js';
import { mainText } from './main-texts.js';

export const companyIpcSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('get') }).strict(),
  z.object({ action: z.literal('observe') }).strict(),
  z.object({ action: z.literal('dispatch'), payload: z.object({ id: z.string().uuid(), consent: z.literal(true) }).strict() }).strict(),
  z.object({ action: z.literal('refreshBroker'), payload: z.object({ id: z.string().uuid() }).strict() }).strict(),
  z.object({ action: z.literal('reviewBroker'), payload: z.object({ id: z.string().uuid(), evidence: z.string().trim().min(3).max(400), consent: z.literal(true) }).strict() }).strict(),
  z.object({ action: z.literal('delegationGrant'), payload: z.object({ delegate: companyChiefSchema, scope: companyDelegationScopeSchema, chiefTitle: companyChiefTitleSchema.optional() }).strict() }).strict(),
  z.object({ action: z.literal('delegationRevoke') }).strict(),
  z.object({ action: z.literal('syncDelegatedTriage') }).strict(),
  z.object({ action: z.literal('sendInvitations'), payload: z.object({ id: z.string().uuid(), consent: z.literal(true) }).strict() }).strict(),
  z.object({ action: z.literal('reconcileMeeting'), payload: z.object({ id: z.string().uuid() }).strict() }).strict(),
  z.object({ action: z.literal('demo') }).strict(),
  z.object({ action: z.literal('activateReal'), consent: z.literal(true) }).strict(),
  z.object({ action: z.literal('restoreDemo'), consent: z.literal(true) }).strict(),
  z.object({ action: z.literal('configure'), payload: z.object({ name: z.string().trim().min(1).max(100), seatCount: z.number().int().min(1).max(99) }).strict() }).strict(),
  z.object({ action: z.literal('create'), payload: z.object({ title: z.string().trim().min(1).max(160), project: z.string().trim().min(1).max(120), owner: companyRoleSchema, origin: z.union([z.literal('ceo'), companyRoleSchema]), acceptance: z.string().trim().min(1).max(1200), engine: z.string().trim().min(1).max(60), model: z.string().trim().min(1).max(120), tokenBudget: z.number().int().min(0).max(10_000_000), timeBudgetMinutes: z.number().int().min(0).max(525600), dueAt: z.number().int().nonnegative().nullable() }).strict() }).strict(),
  z.object({ action: z.literal('prepare'), payload: z.object({ id: z.string().uuid(), seat: companySeatSchema }).strict() }).strict(),
  z.object({ action: z.literal('move'), payload: z.object({ id: z.string().uuid(), status: companyStateNameSchema }).strict() }).strict(),
  z.object({ action: z.literal('authorize'), payload: z.object({ id: z.string().uuid(), ownerId: z.string().uuid(), workerId: z.string().regex(/^worker-[1-9][0-9]*$/), runId: z.string().uuid(), consent: z.literal(true) }).strict() }).strict(),
  z.object({ action: z.literal('report'), payload: z.object({ id: z.string().uuid(), workerId: z.string().regex(/^worker-[1-9][0-9]*$/), runId: z.string().uuid(), reportId: z.string().min(1).max(100), result: z.string().trim().min(1).max(1200), evidence: z.string().trim().min(1).max(1200), outcome: z.enum(['completed','failed']) }).strict() }).strict(),
  z.object({ action: z.literal('confirm'), payload: z.object({ id: z.string().uuid(), workerId: z.string().regex(/^worker-[1-9][0-9]*$/), runId: z.string().uuid(), reportId: z.string().trim().min(1).max(100), evidence: z.string().trim().min(1).max(400) }).strict() }).strict(),
  z.object({ action: z.literal('meeting'), payload: z.object({ title: z.string().trim().min(1).max(160), agenda: z.string().trim().min(1).max(2400), durationMinutes: z.number().int().min(1).max(480), kind: companyMeetingKindSchema.optional() }).strict() }).strict(),
  z.object({ action: z.literal('attendance'), payload: z.object({ id: z.string().uuid(), seat: companySeatSchema, state: companyPresenceSchema, contribution: z.string().max(1600), evidence: z.string().min(1).max(400) }).strict() }).strict(),
  z.object({ action: z.literal('minutes'), payload: z.object({ id: z.string().uuid(), minutes: z.string().max(5000), decisions: z.array(z.string().trim().min(1).max(800)).max(30) }).strict() }).strict(),
  z.object({ action: z.literal('seat'), payload: z.object({ id: z.string().uuid(), seat: companySeatSchema.nullable() }).strict() }).strict()
]);
export type CompanyIpcRequest = z.infer<typeof companyIpcSchema>;
export function registerCompanyIpc(getWindow: () => BrowserWindow | null): void {
  const broker = createCompanyBroker();
  const observer = createCompanyObserver();
  ipcMain.handle('marksCompany:request', async (event, payload: unknown) => {
    const window = getWindow();
    if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
      return { ok: false, error: 'Unauthorized company window' };
    const parsed = companyIpcSchema.safeParse(payload);
    if (!parsed.success) return { ok: false, error: 'Invalid company request' };
    try {
      if (parsed.data.action === 'authorize' || parsed.data.action === 'report' || parsed.data.action === 'confirm' || parsed.data.action === 'attendance') return { ok: false, error: 'Broker/COO identity and evidence verification are not yet connected; operation refused' };
      const request = parsed.data;
      if (request.action === 'dispatch' || request.action === 'sendInvitations' || request.action === 'reviewBroker' || request.action === 'delegationGrant' || request.action === 'delegationRevoke' || request.action === 'activateReal' || request.action === 'restoreDemo') {
        const decision = await dialog.showMessageBox(window, {
          type: 'warning', title: mainText('Authorize Company workers'),
          message: request.action === 'activateReal' ? 'Preserve the complete demonstration in a local versioned backup and start an EMPTY real company?' :
            request.action === 'restoreDemo' ? 'Restore the demonstration backup? This is allowed only before any real company changes.' :
            request.action === 'dispatch' ? 'Start an actual ChatGPT worker for this assigned seat?' :
            request.action === 'sendInvitations' ? 'Send real meeting invitations to connected workers? Some sleeping workers may wake.' :
            request.action === 'reviewBroker' ? 'Personally approve this verified completion as CEO?' :
            request.action === 'delegationGrant' ? 'Delegate only the selected internal operations to this verified chief? Other permissions remain mandatory.' :
            'Revoke COO delegation immediately?',
          detail: request.action === 'activateReal' ? 'All demo tickets, meetings and simulated worker states remain in the backup. No real workers will start. The company name and configured seats are preserved.' :
            request.action === 'restoreDemo' ? 'Backup integrity and the unchanged empty real state will be checked before restoring. The backup file is retained.' :
            'This uses the local worker broker with its existing permissions and budget guidance. It cannot guarantee hard token/time caps.',
          buttons: ['Cancel', 'Authorize'], defaultId: 0, cancelId: 0, noLink: true
        });
        if (decision.response !== 1 || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
          return { ok: false, error: 'Human authorization was not granted' };
      }
      const data = request.action === 'get' ? await getCompany() :
        request.action === 'activateReal' ? await activateRealCompany() :
        request.action === 'restoreDemo' ? await restoreDemoCompany() :
        request.action === 'observe' ? await observer.snapshot() :
        request.action === 'delegationGrant' ? await broker.grantDelegation(request.payload.delegate,request.payload.scope,request.payload.chiefTitle) :
        request.action === 'syncDelegatedTriage' ? await broker.applyDelegatedTriage() :
        request.action === 'dispatch' ? await broker.dispatch(request.payload.id) :
        request.action === 'refreshBroker' ? await broker.refresh(request.payload.id) :
        request.action === 'reviewBroker' ? await broker.review(request.payload.id,request.payload.evidence) :
        request.action === 'sendInvitations' ? await broker.sendInvitations(request.payload.id) :
        request.action === 'reconcileMeeting' ? await broker.reconcileMeeting(request.payload.id) :
        await mutateCompany(request.action, 'payload' in request ? request.payload : undefined);
      return { ok: true, data };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message.slice(0,240) : 'Unable to update company' }; }
  });
}
