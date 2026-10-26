/**
 * Opt-in, owner-only WhatsApp control plane. A WhatsApp message is not a tool grant:
 * the existing durable desktop outbox sends text, and the existing exact-card host
 * approval flow retains final authority. No session bodies are persisted here.
 */
export interface DuplexSession {
  id: string; title: string; conversationId: string | null; updatedAt: number;
}
export interface DuplexApproval {
  conversationId: string; cardId: string; title: string; allow: boolean; outcome: string | null;
}
interface State {
  selected: Record<string, string>;
  receipts: string[];
  pending: Record<string, { sessionId: string; before: string | null; queuedId: string; at: number }>;
  alerts: Record<string, string>;
}
export interface WhatsAppDuplexDeps {
  /** Whitelisted E.164 numbers (digits only); empty disables inbound completely. */
  allowed(): Promise<string[]>;
  sessions(): Promise<DuplexSession[]>;
  active(): Promise<string | null>;
  sendText(number: string, text: string): Promise<void>;
  send(sessionId: string, text: string): Promise<{ id: string; state: string }>;
  approvals(): DuplexApproval[];
  answer(conversationId: string, cardId: string, choice: 'allow' | 'deny'): { ok: true } | { ok: false; error: string };
  latest(sessionId: string): Promise<{ id: string; text: string; seq: number } | null>;
  /** Exact durable user-message receipt, not mere enqueue or browser pickup. */
  delivered(sessionId: string, inputId: string): Promise<number | null>;
  load(): Promise<unknown>;
  save(value: State): Promise<void>;
}

const LIMIT = 400;
const PENDING_MS = 60 * 60_000;
const numberPattern = /^\d{8,15}$/;
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function validatedState(raw: unknown): State {
  const state: State = { selected: {}, receipts: [], pending: {}, alerts: {} };
  if (!isRecord(raw)) return state;
  if (isRecord(raw.selected)) for (const [number, id] of Object.entries(raw.selected)) {
    if (numberPattern.test(number) && typeof id === 'string' && id.length >= 8 && id.length <= 64) state.selected[number] = id;
  }
  if (Array.isArray(raw.receipts)) state.receipts = raw.receipts.filter((id): id is string => typeof id === 'string' && id.length < 256).slice(-LIMIT);
  if (isRecord(raw.pending)) for (const [number, value] of Object.entries(raw.pending)) {
    if (!numberPattern.test(number) || !isRecord(value)) continue;
    if (typeof value.sessionId !== 'string' || value.sessionId.length < 8 || value.sessionId.length > 64 ||
        typeof value.queuedId !== 'string' || typeof value.at !== 'number' ||
        !(typeof value.before === 'string' || value.before === null)) continue;
    if (Date.now() - value.at < PENDING_MS && value.at <= Date.now() + 60_000) {
      state.pending[number] = { sessionId: value.sessionId, queuedId: value.queuedId, before: value.before, at: value.at };
    }
  }
  if (isRecord(raw.alerts)) for (const [number, id] of Object.entries(raw.alerts)) {
    if (numberPattern.test(number) && typeof id === 'string' && id.length < 256) state.alerts[number] = id;
  }
  return state;
}

function clip(text: string, limit = 3200): string {
  return text.length <= limit ? text : text.slice(0, limit - 45) + '\n[Resposta abreviada. Consulte o Chat Marks.]';
}

/** Serializes dedup receipts, selections, dispatch and notifications without losing a reply to replay. */
export function createWhatsAppDuplex(deps: WhatsAppDuplexDeps): {
  incoming(sender: string, messageId: string, text: string): Promise<void>;
  changed(sessionIds: string[]): Promise<void>;
  pollApprovals(): Promise<void>;
} {
  let loading: Promise<State> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  const get = (): Promise<State> => loading ?? (loading = deps.load().then(validatedState));
  const commit = async (state: State): Promise<void> => { await deps.save(state); };
  const serial = (work: () => Promise<void>): Promise<void> => {
    const next = queue.then(work, work); queue = next.catch(() => undefined); return next;
  };
  const authorized = async (number: string): Promise<boolean> => numberPattern.test(number) &&
    (await deps.allowed()).includes(number);
  const available = async (): Promise<DuplexSession[]> => (await deps.sessions())
    .filter(session => !!session.conversationId && session.id.length >= 8).slice(0, 12);
  const target = async (sender: string, state: State, sessions: DuplexSession[]): Promise<DuplexSession | undefined> => {
    const selected = state.selected[sender];
    if (selected) return sessions.find(session => session.id === selected);
    const active = await deps.active();
    return sessions.find(session => session.id === active);
  };
  const respond = (number: string, body: string): Promise<void> => deps.sendText(number, clip(body));
  return {
    incoming(sender, messageId, text) {
      return serial(async () => {
        if (!await authorized(sender) || !messageId || messageId.length > 180 || !text?.trim()) return;
        const state = await get();
        const key = `${sender}:${messageId}`;
        if (state.receipts.includes(key)) return;
        // Commit the receipt *before* any remote action. An ambiguous send is never replayed.
        state.receipts.push(key);
        state.receipts = state.receipts.slice(-LIMIT);
        await commit(state);
        const message = text.trim();
        const sessions = await available();
        const [command, ...rest] = message.split(/\s+/u);
        const arg = rest.join(' ').trim();
        const normalized = command?.toLocaleLowerCase('pt-BR') ?? '';
        if (['/menu', '/ajuda', '/help', '/start'].includes(normalized)) {
          await respond(sender, 'Chat Marks · WhatsApp\n/chats — listar conversas\n/ativo — mostrar conversa selecionada\n/usar 1 — selecionar conversa\n/usar ativo — seguir chat ativo no computador\n/aprovacoes — solicitações pendentes\n/aprovar ID ou /negar ID — decisão para cartão exato\nEnvie uma mensagem normal para conversar.');
          return;
        }
        if (normalized === '/chats') {
          await respond(sender, sessions.length ? 'Conversas:\n' + sessions.map((session, index) => `${index + 1}. ${clip(session.title, 90)}`).join('\n') + '\nUse /usar NUMERO.' : 'Nenhuma conversa ChatGPT disponível.');
          return;
        }
        if (normalized === '/usar') {
          const index = /^\d{1,2}$/.test(arg) ? Number(arg) - 1 : -1;
          const active = arg.toLowerCase() === 'ativo' ? await deps.active() : null;
          const selected = active ? sessions.find(session => session.id === active) : sessions[index];
          if (!selected) { await respond(sender, 'Seleção inválida. Use /chats e /usar 1, ou /usar ativo.'); return; }
          state.selected[sender] = selected.id;
          delete state.pending[sender];
          delete state.alerts[sender];
          await commit(state);
          await respond(sender, `Conversa selecionada: ${clip(selected.title, 130)}. Mensagens serão enviadas apenas a este chat.`);
          return;
        }
        const selected = await target(sender, state, sessions);
        if (normalized === '/ativo') {
          await respond(sender, selected ? `Chat ativo: ${clip(selected.title, 180)}${state.selected[sender] ? ' (selecionado)' : ' (atividade recente do computador)'}.` : 'Nenhum chat ativo. Use /chats e /usar 1.');
          return;
        }
        if (normalized === '/aprovacoes' || normalized === '/aprovações') {
          if (!selected) { await respond(sender, 'Selecione um chat antes: /chats'); return; }
          const cards = deps.approvals().filter(card => card.conversationId === selected.conversationId && !card.outcome);
          await respond(sender, cards.length ? cards.map(card => `Aprovação pendente em ${clip(selected.title, 80)}\nID: ${card.cardId}\n${card.allow ? '/aprovar ' + card.cardId + '\n' : ''}/negar ${card.cardId}`).join('\n\n') : 'Nenhuma aprovação pendente no chat selecionado.');
          return;
        }
        if (normalized === '/aprovar' || normalized === '/negar') {
          if (!selected?.conversationId) { await respond(sender, 'Selecione o chat da aprovação: /chats'); return; }
          const card = deps.approvals().find(item => item.conversationId === selected.conversationId && item.cardId === arg && !item.outcome);
          if (!card || (normalized === '/aprovar' && !card.allow)) { await respond(sender, 'Cartão ausente, expirado ou não autorizado. Use /aprovacoes novamente.'); return; }
          const answer = deps.answer(card.conversationId, card.cardId, normalized === '/aprovar' ? 'allow' : 'deny');
          await respond(sender, answer.ok ? 'Decisão encaminhada ao Chat Marks. Aguarde a confirmação efetiva no ChatGPT; isto não concede permissão permanente.' : 'O cartão mudou ou a decisão não foi aceita. Use /aprovacoes novamente.');
          return;
        }
        if (normalized.startsWith('/')) { await respond(sender, 'Comando não reconhecido. Use /menu.'); return; }
        if (!selected) { await respond(sender, 'Selecione um chat antes de enviar mensagens: /chats e /usar 1.'); return; }
        if (message.length > 4000) { await respond(sender, 'Mensagem longa demais para o canal (máximo 4000 caracteres).'); return; }
        // Only one unacknowledged chat request per sender. Otherwise an answer
        // to an earlier turn could be misattributed to the newest request.
        const existing = state.pending[sender];
        if (existing && Date.now() - existing.at < PENDING_MS) {
          await respond(sender, 'Você já possui uma mensagem aguardando confirmação ou resposta. Aguarde a entrega antes de enviar outra.');
          return;
        }
        if (existing) { delete state.pending[sender]; await commit(state); }
        const before = await deps.latest(selected.id).catch(() => null);
        const entry = await deps.send(selected.id, message);
        state.pending[sender] = { sessionId: selected.id, before: before?.id ?? null, queuedId: entry.id, at: Date.now() };
        await commit(state);
        await respond(sender, `Mensagem enfileirada no Chat Marks (${entry.state}). A entrega ao ChatGPT depende de confirmação do aplicativo.`);
      });
    },
    changed(sessionIds) {
      return serial(async () => {
        const state = await get();
        let dirty = false;
        for (const [sender, pending] of Object.entries(state.pending)) {
          if (sessionIds.length && !sessionIds.includes(pending.sessionId)) continue;
          if (Date.now() - pending.at > PENDING_MS) { delete state.pending[sender]; dirty = true; continue; }
          if (!await authorized(sender)) { delete state.pending[sender]; dirty = true; continue; }
          const latest = await deps.latest(pending.sessionId).catch(() => null);
          const sentSeq = await deps.delivered(pending.sessionId, pending.queuedId).catch(() => null);
          // A different ongoing turn must never be misreported as the WA answer.
          if (sentSeq === null || !latest || latest.seq <= sentSeq || latest.id === pending.before) continue;
          // Preserve the reply across WhatsApp outages: send before clearing the
          // pending receipt, and let the periodic connected poll retry it.
          await respond(sender, 'Resposta de Chat Marks:\n' + latest.text);
          delete state.pending[sender]; dirty = true;
          await commit(state);
        }
        if (dirty) await commit(state);
      });
    },
    pollApprovals() {
      return serial(async () => {
        const state = await get();
        const sessions = await available();
        for (const sender of await deps.allowed()) {
          if (!await authorized(sender)) continue;
          const selected = await target(sender, state, sessions);
          if (!selected?.conversationId) continue;
          const card = deps.approvals().find(item => item.conversationId === selected.conversationId && !item.outcome);
          if (!card) { delete state.alerts[sender]; continue; }
          const fingerprint = `${card.conversationId}:${card.cardId}`;
          if (state.alerts[sender] === fingerprint) continue;
          await respond(sender, `Aprovação pendente em ${clip(selected.title, 100)}.\nID: ${card.cardId}\n${card.allow ? '/aprovar ' + card.cardId + '\n' : ''}/negar ${card.cardId}\nConfirmação final ocorre no host ChatGPT.`);
          state.alerts[sender] = fingerprint;
          await commit(state);
        }
        await commit(state);
      });
    }
  };
}
