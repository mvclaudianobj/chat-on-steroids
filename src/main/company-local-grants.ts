/** Explicit, revocable local Company consent. This ledger cannot authorize OS or ChatGPT prompts. */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const subject = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('coo'), principal: z.literal('marks-coo') }).strict(),
  z.object({ kind: z.literal('worker'), ownerId: z.string().uuid(), runId: z.string().uuid(),
    workerId: z.string().regex(/^worker-[1-9]\d*$/), conversationId: z.string().min(8).max(160) }).strict()
]);
const scope = z.enum(['company-local-read', 'company-local-triage', 'company-local-review']);
const grant = z.object({ id: z.string().uuid(), subject, scope, epoch: z.number().int().nonnegative(), at: z.number().int().nonnegative() }).strict();
const audit = z.object({ id: z.string().uuid(), at: z.number().int().nonnegative(), action: z.enum(['authorize', 'revoke', 'deny']),
  subject, scope, epoch: z.number().int().nonnegative(), reason: z.string().max(120) }).strict();
const request = z.object({ requestId: z.string().uuid(), at: z.number().int().nonnegative(), subject, scope }).strict();
const ledgerSchema = z.object({ version: z.literal(1), epoch: z.number().int().nonnegative(),
  grants: z.array(grant).max(500), audit: z.array(audit).max(2000),
  requests: z.array(request).max(1000).default([]) }).strict();
type Subject = z.infer<typeof subject>;
type Scope = z.infer<typeof scope>;
type Ledger = z.infer<typeof ledgerSchema>;
type Attestation = { local: true; verified: true; subject: Subject };
let directory = '';
let queue: Promise<unknown> = Promise.resolve();
export function initCompanyLocalGrants(userData: string): void { directory = path.join(userData, 'company-local-grants'); queue = Promise.resolve(); }
export function resetCompanyLocalGrantsForTests(): void { directory = ''; queue = Promise.resolve(); }
const blank = (): Ledger => ({ version: 1, epoch: 0, grants: [], audit: [], requests: [] });
async function read(): Promise<Ledger> {
  if (!directory) throw new Error('Local Company grants unavailable');
  try {
    const stat = await fs.lstat(path.join(directory, 'ledger.json'));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512_000) throw new Error('Unsafe grant ledger');
    return ledgerSchema.parse(JSON.parse(await fs.readFile(path.join(directory, 'ledger.json'), 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return blank();
    throw new Error('Local Company grants unreadable');
  }
}
async function write(value: Ledger): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Unsafe grant directory');
  const tmp = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmp, JSON.stringify(ledgerSchema.parse(value)), { flag: 'wx', mode: 0o600 });
    await fs.rename(tmp, path.join(directory, 'ledger.json'));
  } finally { await fs.rm(tmp, { force: true }); }
}
function serialize<T>(action: () => Promise<T>): Promise<T> {
  const result = queue.then(action);
  queue = result.then(() => undefined, () => undefined);
  return result;
}
function same(a: Subject, b: Subject): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function asserted(proof: Attestation | null, target: Subject): boolean {
  // External broker status and renderer-supplied identity are not local attestation.
  return proof?.local === true && proof.verified === true && same(proof.subject, target);
}
export function companyLocalConsentCopy(mode: 'task' | 'agent' | 'coo', selected: Scope): { title: string; detail: string } {
  return {
    title: mode === 'task' ? 'Autorizar esta tarefa' :
      mode === 'agent' ? 'Autorizar sempre ESTE agente para escopo específico' : 'Autorizar COO para tudo sempre',
    detail: `Escopo local: ${selected}. ${mode === 'task' ? 'Uma operação, sem concessão permanente.' :
      mode === 'agent' ? 'Concessão revogável apenas a esta identidade comprovada.' :
      'Todos os escopos internos locais atestáveis do COO, revogáveis.'} Não dispensa autorizações do ChatGPT, sistema operacional ou serviços externos.`
  };
}
/** Requests are durable and unique; merely asking never changes a grant. */
export async function recordLocalCompanyRequest(input: { subject: Subject; scope: Scope; requestId: string }): Promise<{ equivalent: number; suggestExpansion: boolean }> {
  const who = subject.parse(input.subject), selected = scope.parse(input.scope);
  const requestId = z.string().uuid().parse(input.requestId);
  return serialize(async () => {
    const ledger = await read();
    if (!ledger.requests.some(item => item.requestId === requestId)) {
      ledger.requests.push({ requestId, subject: who, scope: selected, at: Date.now() });
      ledger.requests = ledger.requests.slice(-1000);
      await write(ledger);
    }
    const equivalent = ledger.requests.filter(item => same(item.subject, who) && item.scope === selected).length;
    return { equivalent, suggestExpansion: equivalent >= 3 };
  });
}
export async function localGrantDecision(input: { mode: 'task' | 'agent' | 'coo'; subject: Subject; scope: Scope;
  attestation: Attestation | null; consent: boolean; requestId: string }): Promise<{ authorized: boolean; epoch: number; id: string | null }> {
  const chosen = subject.parse(input.subject), selected = scope.parse(input.scope);
  if (!z.string().uuid().safeParse(input.requestId).success) throw new Error('Invalid consent request');
  return serialize(async () => {
    const ledger = await read();
    if (!input.consent || !asserted(input.attestation, chosen) ||
      (input.mode === 'coo' && chosen.kind !== 'coo')) {
      return { authorized: false, epoch: ledger.epoch, id: null };
    }
    if (input.mode === 'task') return { authorized: true, epoch: ledger.epoch, id: null };
    const scopes: Scope[] = input.mode === 'coo' ? scope.options : [selected];
    const existing = ledger.grants.find(g => same(g.subject, chosen) && scopes.includes(g.scope));
    if (existing && input.mode !== 'coo') return { authorized: true, epoch: ledger.epoch, id: existing.id };
    if (scopes.every(item => ledger.grants.some(g => same(g.subject, chosen) && g.scope === item)))
      return { authorized: true, epoch: ledger.epoch, id: ledger.grants.find(g => same(g.subject, chosen) && g.scope === selected)?.id ?? null };
    ledger.epoch++;
    for (const item of scopes) {
      if (ledger.grants.some(g => same(g.subject, chosen) && g.scope === item)) continue;
      const id = randomUUID();
      ledger.grants.push({ id, subject: chosen, scope: item, epoch: ledger.epoch, at: Date.now() });
      ledger.audit.push({ id: randomUUID(), at: Date.now(), action: 'authorize', subject: chosen, scope: item,
        epoch: ledger.epoch, reason: input.requestId });
    }
    await write(ledger);
    return { authorized: true, epoch: ledger.epoch, id: ledger.grants.find(g => same(g.subject, chosen) && g.scope === selected)?.id ?? null };
  });
}
export async function revokeLocalCompanyGrant(id: string): Promise<boolean> {
  return serialize(async () => {
    const ledger = await read();
    const found = ledger.grants.find(g => g.id === id);
    if (!found) return false;
    ledger.epoch++;
    ledger.grants = ledger.grants.filter(g => g.id !== id);
    ledger.audit.push({ id: randomUUID(), at: Date.now(), action: 'revoke', subject: found.subject,
      scope: found.scope, epoch: ledger.epoch, reason: id });
    await write(ledger);
    return true;
  });
}
export async function readLocalCompanyGrants(): Promise<Ledger> { return serialize(read); }
export async function verifyLocalCompanyGrant(proof: Attestation | null, selected: Scope): Promise<boolean> {
  if (!proof || !asserted(proof, proof.subject)) return false;
  return serialize(async () => (await read()).grants.some(g => g.scope === selected && same(g.subject, proof.subject)));
}
