/** marks-coo's opt-in host approval answers: exact attribution, CEO risk hold, audit, revocation. Synthetic only. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approvalAnswerFor, approvalCardView, approvalDecisionStatus, noteApprovalCard, requestApprovalAnswer, resetApprovalWaits,
  settleApprovalAnswer, withdrawApprovalAnswer, type ApprovalWaitDeps
} from '../src/main/approval-wait.js';
import {
  companyApprovalOwner, cooApprovalCardTruncated, cooApprovalRisk, cooApprovalTool, createCooHostApprover, type CooApprovalDeps
} from '../src/main/company-coo-approval.js';
import { getCompany, initCompanyStore, mutateCompany, resetCompanyStoreForTests } from '../src/main/company-store.js';
import { companyIpcSchema } from '../src/main/company-ipc.js';
import { COO_HOST_APPROVAL_DEFAULT_RISKS, companySnapshotSchema, emptyCompany, type CompanySnapshot } from '../src/shared/company.js';
import { mountCooHostApproval } from '../src/renderer/company-coo-approval-ui.js';

const WORKER_CHAT = '6a1b2c3d-0000-4000-8000-00000000aaaa';
const OTHER_CHAT = '6a1b2c3d-0000-4000-8000-00000000bbbb';
const TICKET = '00000000-0000-4000-8000-000000000001';
const OWNER = '00000000-0000-4000-8000-000000000002';
const RUN = '00000000-0000-4000-8000-000000000003';
const SAFE = ['Allow ChatGPT to use Chat Marks Core?', 'Tool: read_file', 'path: src/index.ts'];

function ticket(conversationId = WORKER_CHAT, phase: 'running' | 'reported' = 'running', id = TICKET): CompanySnapshot['requests'][number] {
  return {
    id, title: 'Synthetic worker ticket', project: 'Tests', origin: 'ceo', owner: 'marks-cto', seat: 'marks1', engine: 'chatgpt', model: 'fake',
    acceptance: 'Verify', tokenBudget: 100, timeBudgetMinutes: 30, tokensUsed: 0, minutesUsed: 0, dueAt: null, status: 'working',
    raci: { responsible: 'marks1', accountable: 'ceo', consulted: [], informed: [] },
    execution: { mode: 'live', phase, ownerId: OWNER, workerId: 'worker-1', runId: RUN, conversationId, reportId: null, result: null, evidence: null, authorizedAt: 1 },
    history: [], createdAt: 1, updatedAt: 1
  };
}
function company(enabled = true, requests = [ticket()]): CompanySnapshot {
  const snapshot = emptyCompany();
  snapshot.requests = requests;
  snapshot.cooHostApproval.enabled = enabled;
  snapshot.cooHostApproval.epoch = 3;
  return companySnapshotSchema.parse(snapshot);
}

describe('exact Company ownership', () => {
  it('owns only the conversation id the broker recorded on one active live ticket', () => {
    expect(companyApprovalOwner(company(), WORKER_CHAT)).toEqual({ kind: 'owned', requestId: TICKET, seat: 'marks1' });
    // The person's own chat, whatever it is called, is not the Company's.
    expect(companyApprovalOwner(company(), OTHER_CHAT)).toBeNull();
    expect(companyApprovalOwner(company(true, [ticket(WORKER_CHAT, 'reported')]), WORKER_CHAT)?.kind).toBe('ambiguous');
    expect(companyApprovalOwner(company(true, [ticket(), ticket(WORKER_CHAT, 'running', '00000000-0000-4000-8000-000000000009')]), WORKER_CHAT)?.kind).toBe('ambiguous');
    const demo = company(); demo.demo = true;
    expect(companyApprovalOwner(demo, WORKER_CHAT)).toBeNull();
  });
});

describe('CEO risk list', () => {
  const terms = [...COO_HOST_APPROVAL_DEFAULT_RISKS];
  it.each([
    ['exec_command: rm -rf build', 'rm -r'], ['git push --force origin main', '--force'], ['npm publish --access public', 'publish'],
    ['git tag v2.1.47', 'git tag'], ['read ~/.config/app/vault.json', 'vault'], ['curl https://example.test', 'curl'],
    ['ssh build@remote', 'ssh'], ['tool: fs_delete', 'delete']
  ])('holds %s', (line, term) => expect(cooApprovalRisk(['Allow?', line], terms)).toBe(term));
  it('matches at word starts only and passes ordinary reads', () => {
    expect(cooApprovalRisk(SAFE, terms)).toBeNull();
    expect(cooApprovalRisk(['submit the form -r flag'], ['rm -r'])).toBeNull();
    expect(cooApprovalRisk(['DELETED rows'], ['delete'])).toBe('delete');
  });
  it('treats a card at the page bounds as possibly cut off and names its tool', () => {
    expect(cooApprovalCardTruncated(SAFE)).toBe(false);
    expect(cooApprovalCardTruncated(Array.from({ length: 8 }, (_, i) => `line ${i}`))).toBe(true);
    expect(cooApprovalCardTruncated(['x'.repeat(300)])).toBe(true);
    expect(cooApprovalTool(SAFE)).toBe('read_file');
  });
});

describe('background answer through the existing exact-card path', () => {
  const waitDeps: ApprovalWaitDeps = { record: async () => ({ seq: 1, time: 1 }), notify: () => true, log: () => undefined };
  let snapshot: CompanySnapshot;
  let audit: Array<Record<string, unknown>>;
  let notices: string[];
  let woken: string[];
  let deps: CooApprovalDeps;
  const show = (conversationId: string, lines = SAFE, allow = true, id = 'card-0001-abcd') =>
    noteApprovalCard(conversationId, true, null, waitDeps, Date.now(), { id, lines, allow });
  beforeEach(() => {
    resetApprovalWaits();
    snapshot = company();
    audit = []; notices = []; woken = [];
    deps = {
      company: async () => snapshot,
      audit: async entry => {
        if (entry.decision === 'allowed' && (!snapshot.cooHostApproval.enabled || snapshot.cooHostApproval.epoch !== entry.epoch))
          throw new Error('COO host approval authority changed');
        audit.push(entry);
      },
      card: approvalCardView,
      answer: (conversationId, cardId) => requestApprovalAnswer(conversationId, cardId, 'allow'),
      status: (conversationId, cardId) => approvalDecisionStatus(conversationId, cardId),
      withdraw: withdrawApprovalAnswer,
      wake: conversationId => { woken.push(conversationId); },
      session: async () => 'session-1',
      notify: (_title, excerpt) => { notices.push(excerpt); },
      redact: text => text,
      log: () => undefined
    };
  });
  afterEach(() => resetApprovalWaits());

  it('files Allow once for a Company worker card without the chat open, wakes its page and audits it', async () => {
    const approver = createCooHostApprover(deps);
    await show(WORKER_CHAT);
    await approver.consider(WORKER_CHAT);
    expect(approvalAnswerFor(WORKER_CHAT)).toMatchObject({ cardId: 'card-0001-abcd', choice: 'allow' });
    expect(woken).toEqual([WORKER_CHAT]);
    expect(audit).toEqual([expect.objectContaining({ actor: 'marks-coo', decision: 'allowed', tool: 'read_file', conversationId: WORKER_CHAT,
      sessionId: 'session-1', requestId: TICKET, seat: 'marks1', cardId: 'card-0001-abcd', epoch: 3, fingerprint: expect.stringMatching(/^[0-9a-f]{16}$/) })]);
    // The page presses it and reports; the next poll settles the audit.
    const answer = approvalAnswerFor(WORKER_CHAT)!;
    expect(settleApprovalAnswer(WORKER_CHAT, answer.token, 'clicked')).toBe(true);
    await noteApprovalCard(WORKER_CHAT, false, null, waitDeps);
    await approver.consider(WORKER_CHAT);
    expect(audit.map(row => row.decision)).toEqual(['allowed', 'clicked']);
    expect(approver.pending()).toBe(0);
    // A standing card is decided once.
    await approver.consider(WORKER_CHAT);
    expect(audit).toHaveLength(2);
  });

  it('leaves the person\'s own chats alone and does nothing while the policy is off', async () => {
    const approver = createCooHostApprover(deps);
    await show(OTHER_CHAT);
    await approver.consider(OTHER_CHAT);
    snapshot = company(false);
    await show(WORKER_CHAT);
    await approver.consider(WORKER_CHAT);
    expect(approvalAnswerFor(OTHER_CHAT)).toBeNull();
    expect(approvalAnswerFor(WORKER_CHAT)).toBeNull();
    expect(audit).toEqual([]);
  });

  it('holds risky, unattributable and Allow-disabled cards for the CEO and notifies once', async () => {
    const approver = createCooHostApprover(deps);
    await show(WORKER_CHAT, ['Allow ChatGPT to use Chat Marks Core?', 'Tool: exec_command', 'cmd: git push --force origin main']);
    await approver.consider(WORKER_CHAT);
    await approver.consider(WORKER_CHAT);
    expect(approvalAnswerFor(WORKER_CHAT)).toBeNull();
    expect(audit).toEqual([expect.objectContaining({ decision: 'held-risk', reason: 'matches CEO risk term "--force"' })]);
    expect(notices).toEqual(['marks1 · exec_command · matches CEO risk term "--force"']);

    snapshot = company(true, [ticket(WORKER_CHAT, 'reported')]);
    await show(WORKER_CHAT, SAFE, true, 'card-0002-abcd');
    await approver.consider(WORKER_CHAT);
    expect(audit.at(-1)).toMatchObject({ decision: 'held-unattributed', cardId: 'card-0002-abcd' });

    snapshot = company();
    await show(WORKER_CHAT, SAFE, false, 'card-0003-abcd');
    await approver.consider(WORKER_CHAT);
    expect(audit.at(-1)).toMatchObject({ decision: 'held-unavailable' });
    expect(approvalAnswerFor(WORKER_CHAT)).toBeNull();
    expect(notices).toHaveLength(3);
  });

  it('never overrides an answer a person already filed', async () => {
    const approver = createCooHostApprover(deps);
    await show(WORKER_CHAT);
    expect(requestApprovalAnswer(WORKER_CHAT, 'card-0001-abcd', 'deny').ok).toBe(true);
    await approver.consider(WORKER_CHAT);
    expect(approvalAnswerFor(WORKER_CHAT)?.choice).toBe('deny');
    expect(audit).toEqual([]);
  });

  it('revocation withdraws an answer no page took and leaves the card for the person', async () => {
    const approver = createCooHostApprover(deps);
    await show(WORKER_CHAT);
    await approver.consider(WORKER_CHAT);
    expect(approvalAnswerFor(WORKER_CHAT)).not.toBeNull();
    snapshot = company(false);
    expect(await approver.revoke('COO host approval revoked by the CEO')).toBe(1);
    expect(approvalAnswerFor(WORKER_CHAT)).toBeNull();
    expect(audit.map(row => row.decision)).toEqual(['allowed', 'revoked']);
    // The person can still answer it themselves; the COO does not come back for it.
    await approver.consider(WORKER_CHAT);
    expect(approvalAnswerFor(WORKER_CHAT)).toBeNull();
    expect(requestApprovalAnswer(WORKER_CHAT, 'card-0001-abcd', 'deny').ok).toBe(true);
  });

  it('a revocation during the decision sends nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const approver = createCooHostApprover({ ...deps, session: async () => { await gate; return 'session-1'; } });
    await show(WORKER_CHAT);
    const deciding = approver.consider(WORKER_CHAT);
    await new Promise(resolve => setTimeout(resolve, 0));
    snapshot = company(false);
    const revoked = approver.revoke('revoked');
    release();
    await Promise.all([deciding, revoked]);
    expect(approvalAnswerFor(WORKER_CHAT)).toBeNull();
    expect(audit.some(row => row.decision === 'allowed')).toBe(false);
  });
});

describe('persistent policy and audit', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'marks-coo-host-')); initCompanyStore(dir); });
  afterEach(async () => { resetCompanyStoreForTests(); await rm(dir, { recursive: true, force: true }); });

  it('is off by default with the CEO risk list, bumps the epoch on every change and refuses a stale Allow row', async () => {
    const initial = await getCompany();
    expect(initial.cooHostApproval).toMatchObject({ enabled: false, epoch: 0, audit: [] });
    expect(initial.cooHostApproval.riskTerms).toEqual([...COO_HOST_APPROVAL_DEFAULT_RISKS]);
    const on = await mutateCompany('cooHostPolicy', { enabled: true, riskTerms: ['Delete', 'delete', ' --force '] });
    expect(on.cooHostApproval).toMatchObject({ enabled: true, epoch: 1, riskTerms: ['delete', '--force'] });
    const row = { at: 5, actor: 'marks-coo' as const, conversationId: WORKER_CHAT, sessionId: null, requestId: null, seat: 'marks1' as const,
      cardId: 'card-0001-abcd', fingerprint: '0123456789abcdef', tool: 'read_file', decision: 'allowed' as const, reason: 'exact Company ownership', epoch: 1 };
    await mutateCompany('cooHostAudit', row);
    await mutateCompany('cooHostAudit', row);
    await mutateCompany('cooHostPolicy', { enabled: false, riskTerms: ['delete'] });
    await expect(mutateCompany('cooHostAudit', { ...row, cardId: 'card-0002-abcd' })).rejects.toThrow('authority changed');
    await mutateCompany('cooHostAudit', { ...row, decision: 'revoked', reason: 'revoked' });
    resetCompanyStoreForTests(); initCompanyStore(dir);
    const reread = await getCompany();
    expect(reread.cooHostApproval.enabled).toBe(false);
    expect(reread.cooHostApproval.epoch).toBe(2);
    expect(reread.cooHostApproval.audit.map(entry => entry.decision)).toEqual(['revoked', 'allowed']);
    expect(reread.activities.some(entry => entry.actor === 'marks-coo' && entry.message.includes('Host approval allowed'))).toBe(true);
  });

  it('refuses the policy on demonstration data and validates the IPC payload', async () => {
    await mutateCompany('demo', undefined);
    await expect(mutateCompany('cooHostPolicy', { enabled: true, riskTerms: [] })).rejects.toThrow('real company');
    expect(companyIpcSchema.safeParse({ action: 'cooHostPolicy', payload: { enabled: true, riskTerms: ['ok-term'] } }).success).toBe(true);
    expect(companyIpcSchema.safeParse({ action: 'cooHostPolicy', payload: { enabled: true, riskTerms: ['x'] } }).success).toBe(false);
  });
});

describe('Company settings section', () => {
  const doms: JSDOM[] = [];
  afterEach(() => { for (const dom of doms) dom.window.close(); doms.length = 0; vi.unstubAllGlobals(); });
  const host = () => {
    const dom = new JSDOM('<section id="host"></section>', { url: 'https://local.test/' }); doms.push(dom);
    vi.stubGlobal('window', dom.window); vi.stubGlobal('document', dom.window.document);
    return dom.window.document.getElementById('host')!;
  };
  it('toggles, edits the risk list, revokes in one click and lists the audit', () => {
    const node = host();
    const snapshot = company();
    snapshot.cooHostApproval.audit = [{ at: 5, actor: 'marks-coo', conversationId: WORKER_CHAT, sessionId: null, requestId: TICKET, seat: 'marks1',
      cardId: 'card-0001-abcd', fingerprint: '0123456789abcdef', tool: 'read_file', decision: 'allowed', reason: 'exact Company ownership', epoch: 3 }];
    const change = vi.fn();
    mountCooHostApproval(node, snapshot, change);
    expect(node.dataset.cooHostApproval).toBe('on');
    expect(node.querySelector('li[data-decision="allowed"]')?.textContent).toContain('read_file');
    const terms = node.querySelector<HTMLTextAreaElement>('#companyCooHostTerms')!;
    terms.value = 'Delete\nx\n--force';
    const buttons = [...node.querySelectorAll('button')];
    buttons.find(button => button.textContent === 'Save COO host approval')!.click();
    expect(change).toHaveBeenLastCalledWith({ action: 'cooHostPolicy', payload: { enabled: true, riskTerms: ['delete', '--force'] } });
    buttons.find(button => button.textContent === 'Revoke COO host approvals now')!.click();
    expect(change).toHaveBeenLastCalledWith({ action: 'cooHostPolicy', payload: { enabled: false, riskTerms: snapshot.cooHostApproval.riskTerms } });
  });
  it.each(['de', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'ru', 'tr', 'vi', 'zh-CN', 'zh-TW'])('translates every COO host approval label in %s', locale => {
    const catalog = JSON.parse(readFileSync(`src/renderer/locales/${locale}.json`, 'utf8')) as Record<string, string>;
    const source = readFileSync('src/renderer/company-coo-approval-ui.ts', 'utf8');
    const keys = [...source.matchAll(/\b(?:t|button)\('([^']+)'/g), ...source.matchAll(/: '([A-Z][^']+)'/g)].map(match => match[1]!);
    expect(keys.length).toBeGreaterThan(18);
    for (const key of keys) expect(catalog[key], `${locale}: ${key}`).toBeTruthy();
  });
});
