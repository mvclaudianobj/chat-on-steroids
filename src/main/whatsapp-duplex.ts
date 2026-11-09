import { randomInt } from 'node:crypto';

/**
 * Opt-in, owner-only WhatsApp control plane. A WhatsApp message is not a tool grant:
 * the existing durable desktop outbox sends text, and the existing exact-card host
 * approval flow retains final authority. No session bodies are persisted here.
 */
export interface DuplexSession {
  id: string; title: string; conversationId: string | null; updatedAt: number;
}
export interface DuplexApproval {
  conversationId: string; cardId: string; title: string; allow: boolean; outcome: string | null; details?: string;
}
interface DirectRef { code: string; conversationId: string; cardId: string; at: number; decided: boolean }
interface AnsweredRef { conversationId: string; cardId: string; choice: 'allow' | 'deny'; at: number }
interface State {
  selected: Record<string, string>;
  receipts: string[];
  pending: Record<string, { sessionId: string; before: string | null; queuedId: string; at: number }>;
  alerts: Record<string, string>;
  /** A short number refers only to the exact live card this phone was shown. */
  approvalRefs: Record<string, { sessionId: string; conversationId: string; cardIds: string[]; at: number }>;
  /** Codes minted into an approval-pending notification: each names one exact card, for a short time. */
  directRefs: Record<string, DirectRef[]>;
  /** The one decision this phone filed and has not yet heard the app's outcome for. */
  answered: Record<string, AnsweredRef>;
  /** Final answers already shown to a deliberately selected phone; no bodies stored. */
  mirrored: Record<string, { sessionId: string; seq: number; id: string }>;
}
export interface WhatsAppDuplexDeps {
  /** Whitelisted E.164 numbers (digits only); empty disables inbound completely. */
  allowed(): Promise<string[]>;
  sessions(): Promise<DuplexSession[]>;
  active(): Promise<string | null>;
  sendText(number: string, text: string): Promise<void>;
  send(sessionId: string, text: string): Promise<{ id: string; state: string }>;
  approvals(): DuplexApproval[];
  /** Page observation only; never proof of an actual host grant. */
  approvalStatus?(conversationId: string, cardId: string): 'pending' | 'clicked' | 'dismissed' | 'not_confirmed' | 'card_changed' | 'unavailable' | 'expired' | null;
  answer(conversationId: string, cardId: string, choice: 'allow' | 'deny'): { ok: true } | { ok: false; error: string };
  latest(sessionId: string): Promise<{ id: string; text: string; seq: number } | null>;
  completedSince?(sessionId: string, afterSeq: number): Promise<Array<{id:string; text:string; seq:number}>>;
  deliveryStatus?(number: string): 'accepted' | 'server' | 'delivered' | 'read' | 'failed' | 'untracked' | null;
  /** Exact durable user-message receipt, not mere enqueue or browser pickup. */
  delivered(sessionId: string, inputId: string): Promise<number | null>;
  load(): Promise<unknown>;
  save(value: State): Promise<void>;
}

const LIMIT = 400;
const PENDING_MS = 60 * 60_000;
const APPROVAL_REF_MS = 10 * 60_000;
const numberPattern = /^\d{8,15}$/;
const codePattern = /^\d{4}$/;
const DIRECT_LIMIT = 20;
/** Case- and accent-insensitive command word; the leading slash is optional. */
function commandWord(word: string | undefined): string {
  return (word ?? '').replace(/^\//u, '').normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');
}
/** Without a slash, only an exact command shape is a command, so ordinary chat text still reaches the chat. */
function slashlessCommand(word: string, arg: string): boolean {
  if (word === 'aprovar' || word === 'negar') return true;
  if (word === 'usar') return /^(\d{1,2}|ativo)$/iu.test(arg);
  return !arg && ['menu', 'ajuda', 'help', 'chats', 'ativo', 'estado', 'aprovacoes'].includes(word);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function validatedState(raw: unknown): State {
  const state: State = { selected: {}, receipts: [], pending: {}, alerts: {}, approvalRefs: {}, directRefs: {}, answered: {}, mirrored: {} };
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
  if (isRecord(raw.approvalRefs)) for (const [number, value] of Object.entries(raw.approvalRefs)) {
    if (!numberPattern.test(number) || !isRecord(value) || typeof value.sessionId !== 'string' ||
        value.sessionId.length < 8 || value.sessionId.length > 64 ||
        typeof value.conversationId !== 'string' || value.conversationId.length > 256 ||
        !Array.isArray(value.cardIds) || value.cardIds.length === 0 || value.cardIds.length > 12 ||
        !value.cardIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 256) ||
        typeof value.at !== 'number' || !Number.isFinite(value.at) ||
        Date.now() - value.at >= APPROVAL_REF_MS || value.at > Date.now() + 60_000) continue;
    state.approvalRefs[number] = { sessionId: value.sessionId, conversationId: value.conversationId, cardIds: value.cardIds, at: value.at };
  }
  const fresh = (at: unknown, limit: number): at is number => typeof at === 'number' && Number.isFinite(at) &&
    Date.now() - at < limit && at <= Date.now() + 60_000;
  const cardRef = (value: Record<string, unknown>): boolean => typeof value.conversationId === 'string' &&
    value.conversationId.length > 0 && value.conversationId.length <= 256 &&
    typeof value.cardId === 'string' && value.cardId.length > 0 && value.cardId.length <= 256;
  if (isRecord(raw.directRefs)) for (const [number, list] of Object.entries(raw.directRefs)) {
    if (!numberPattern.test(number) || !Array.isArray(list)) continue;
    const refs = list.filter((value): value is Record<string, unknown> => isRecord(value) && cardRef(value) &&
      typeof value.code === 'string' && codePattern.test(value.code) && fresh(value.at, APPROVAL_REF_MS))
      .slice(-DIRECT_LIMIT).map(value => ({ code: value.code as string, conversationId: value.conversationId as string,
        cardId: value.cardId as string, at: value.at as number, decided: value.decided === true }));
    if (refs.length) state.directRefs[number] = refs;
  }
  if (isRecord(raw.answered)) for (const [number, value] of Object.entries(raw.answered)) {
    if (!numberPattern.test(number) || !isRecord(value) || !cardRef(value) ||
        (value.choice !== 'allow' && value.choice !== 'deny') || !fresh(value.at, PENDING_MS)) continue;
    state.answered[number] = { conversationId: value.conversationId as string, cardId: value.cardId as string,
      choice: value.choice, at: value.at };
  }
  if (isRecord(raw.mirrored)) for (const [number, value] of Object.entries(raw.mirrored)) {
    if (!numberPattern.test(number) || !isRecord(value) || typeof value.sessionId !== 'string' ||
        value.sessionId.length < 8 || value.sessionId.length > 64 ||
        typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 0 ||
        typeof value.id !== 'string' || value.id.length > 256) continue;
    state.mirrored[number] = { sessionId: value.sessionId, seq: value.seq, id: value.id };
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
  /** A short reply code bound to one exact card, for an approval-pending notice to this number. */
  approvalCode(number: string, conversationId: string, cardId: string): Promise<string | null>;
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
  // Access may be revoked while awaiting sessions/host events. Check again at
  // the irreversible send boundary, not only at command admission.
  const respond = async (number: string, body: string): Promise<boolean> => {
    if (!await authorized(number)) return false;
    await deps.sendText(number, clip(body));
    return true;
  };
  const rememberCards = (state: State, sender: string, session: DuplexSession, cards: DuplexApproval[]): void => {
    if (!session.conversationId || !cards.length) { delete state.approvalRefs[sender]; return; }
    state.approvalRefs[sender] = {
      sessionId: session.id, conversationId: session.conversationId,
      cardIds: cards.slice(0, 12).map(card => card.cardId), at: Date.now()
    };
  };
  const displayCards = (session: DuplexSession, cards: DuplexApproval[]): string =>
    cards.slice(0, 12).map((card, index) => {
      const code = index + 1;
      return `Aprovação ${code} em ${clip(session.title, 80)}\n${clip(card.title, 140)}${card.details ? '\n' + clip(card.details, 380) : ''}\n${card.allow ? '/aprovar ' + code + '\n' : ''}/negar ${code}\nDecisão para este cartão apenas; confirmação final ocorre no ChatGPT.`;
    }).join('\n\n');
  const chatTitle = async (conversationId: string): Promise<string> =>
    clip((await deps.sessions().catch(() => [])).find(session => session.conversationId === conversationId)?.title ?? 'ChatGPT', 80);
  const failure: Record<string, string> = {
    not_confirmed: 'a página do ChatGPT não confirmou o clique',
    card_changed: 'o cartão mudou antes do clique; nada foi decidido',
    unavailable: 'o botão não estava disponível no cartão',
    expired: 'o ChatGPT não confirmou a decisão a tempo'
  };
  /** Reports the app's observed outcome of this phone's last decision, once. */
  const approvalReceipt = async (sender: string, state: State): Promise<boolean> => {
    const done = state.answered[sender];
    if (!done || !deps.approvalStatus) return false;
    const outcome = deps.approvalStatus(done.conversationId, done.cardId);
    if (outcome === 'pending') return false;
    delete state.answered[sender];
    const ref = state.approvalRefs[sender];
    if (ref?.conversationId === done.conversationId && ref.cardIds.includes(done.cardId)) delete state.approvalRefs[sender];
    await commit(state);
    const chat = await chatTitle(done.conversationId);
    const verb = done.choice === 'allow' ? 'aprovar' : 'negar';
    const result = outcome === 'clicked'
      ? `${done.choice === 'allow' ? 'Aprovado' : 'Negado'} no chat ${chat}: o Chat Marks confirmou o clique em ${done.choice === 'allow' ? 'Permitir' : 'Negar'} neste cartão. Não é uma permissão permanente.`
      : outcome === 'dismissed'
        ? `O cartão foi retirado da tela do ChatGPT após o clique para ${verb} (chat ${chat}). Isso não comprova que o host concedeu a permissão; confira a execução da ferramenta.`
        : `Não foi possível ${verb} no chat ${chat}: ${outcome ? failure[outcome] ?? `estado ${outcome}` : 'o Chat Marks não tem mais o registro desta decisão'}. A autorização não foi confirmada; envie aprovacoes para ver os cartões pendentes.`;
    return respond(sender, result);
  };
  const refusal: Record<string, string> = {
    answer_pending: 'Já existe uma decisão em andamento para este cartão; aguarde o resultado.',
    allow_unavailable: 'Este cartão não permite aprovar; responda com negar ou decida no Chat Marks.',
    no_card: 'O cartão não está mais visível no ChatGPT. Envie aprovacoes para ver os pendentes.'
  };
  /** The one answer path for every WhatsApp decision: the exact card through the app's own flow. */
  const decide = async (sender: string, state: State, card: DuplexApproval, choice: 'allow' | 'deny'): Promise<boolean> => {
    const answer = deps.answer(card.conversationId, card.cardId, choice);
    if (!answer.ok) {
      await respond(sender, refusal[answer.error] ?? 'O cartão mudou ou a decisão não foi aceita. Use /aprovacoes novamente.');
      return false;
    }
    if (deps.approvalStatus) state.answered[sender] = { conversationId: card.conversationId, cardId: card.cardId, choice, at: Date.now() };
    else delete state.approvalRefs[sender];
    await commit(state);
    await respond(sender, `Decisão (${choice === 'allow' ? 'aprovar' : 'negar'}) encaminhada ao cartão no chat ${await chatTitle(card.conversationId)}. ${deps.approvalStatus ? 'O resultado confirmado pelo app chegará aqui.' : 'Aguarde a confirmação efetiva no ChatGPT.'} Isto não concede permissão permanente.`);
    return true;
  };
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
        if (!await authorized(sender)) return;
        const [command, ...rest] = message.split(/\s+/u);
        const arg = rest.join(' ').trim();
        const word = commandWord(command);
        // A slash names a command outright; without one, only an exact command shape does.
        const normalized = command?.startsWith('/') || slashlessCommand(word, arg) ? '/' + word : '';
        if (['/menu', '/ajuda', '/help', '/start'].includes(normalized)) {
          await respond(sender, 'Chat Marks · WhatsApp\n/chats — listar conversas\n/ativo — mostrar conversa selecionada\n/usar 1 — selecionar conversa\n/usar ativo — seguir chat ativo no computador\n/estado — consultar confirmação de entrega\n/aprovacoes — solicitações pendentes\n/aprovar 1 ou /negar 1 — decisão para cartão exato\naprovar CÓDIGO ou negar CÓDIGO — responde o cartão do aviso (10 min)\nA barra é opcional nos comandos.\nEnvie uma mensagem normal para conversar.');
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
          delete state.approvalRefs[sender];
          const last = await deps.latest(selected.id).catch(() => null);
          state.mirrored[sender] = { sessionId: selected.id, seq: last?.seq ?? 0, id: last?.id ?? '' };
          await commit(state);
          await respond(sender, `Conversa selecionada: ${clip(selected.title, 130)}. Mensagens serão enviadas apenas a este chat.`);
          return;
        }
        const selected = await target(sender, state, sessions);
        if (normalized === '/ativo') {
          await respond(sender, selected ? `Chat ativo: ${clip(selected.title, 180)}${state.selected[sender] ? ' (selecionado)' : ' (atividade recente do computador)'}.` : 'Nenhum chat ativo. Use /chats e /usar 1.');
          return;
        }
        if (normalized === '/estado') {
          const phase = deps.deliveryStatus?.(sender) ?? null;
          const descriptions = {
            accepted: 'Envio aceito pelo Baileys; entrega ao aparelho ainda não confirmada.',
            server: 'Envio confirmado pelo servidor WhatsApp; entrega ao aparelho ainda não confirmada.',
            delivered: 'Confirmação de entrega ao destinatário recebida.',
            read: 'Confirmação de leitura recebida.',
            failed: 'Falha reportada pelo WhatsApp; verifique a conexão.',
            untracked: 'O transporte não retornou ID; não é possível confirmar a entrega.'
          };
          await respond(sender, phase ? descriptions[phase] : 'Ainda não existe confirmação de entrega para este número.');
          return;
        }
        if ((normalized === '/aprovar' || normalized === '/negar') && codePattern.test(arg)) {
          // A notice's code names its exact card and chat; no chat selection is needed or consulted.
          const choice = normalized === '/aprovar' ? 'allow' : 'deny';
          const refs = (state.directRefs[sender] ?? []).filter(ref => Date.now() - ref.at < APPROVAL_REF_MS);
          const ref = refs.find(item => item.code === arg);
          if (!ref) { await respond(sender, `O código ${arg} não vale: não existe ou passou da validade de 10 minutos. Nada foi decidido. Envie aprovacoes para ver os cartões pendentes.`); return; }
          const chat = await chatTitle(ref.conversationId);
          const card = deps.approvals().find(item => item.conversationId === ref.conversationId && item.cardId === ref.cardId);
          if (ref.decided || !card || card.outcome) {
            await respond(sender, `O cartão do código ${arg} (chat ${chat}) já foi respondido ou não está mais pendente. Nada foi decidido agora.`);
            return;
          }
          if (choice === 'allow' && !card.allow) { await respond(sender, `O cartão do código ${arg} (chat ${chat}) não permite aprovar. Responda negar ${arg} ou decida no Chat Marks.`); return; }
          if (await decide(sender, state, card, choice)) {
            ref.decided = true;
            state.directRefs[sender] = refs;
            await commit(state);
          }
          return;
        }
        if (normalized === '/aprovacoes') {
          if (!selected) { await respond(sender, 'Selecione um chat antes: /chats'); return; }
          const cards = deps.approvals().filter(card => card.conversationId === selected.conversationId && !card.outcome);
          rememberCards(state, sender, selected, cards);
          await commit(state);
          await respond(sender, cards.length ? displayCards(selected, cards) : 'Nenhuma aprovação pendente no chat selecionado.');
          return;
        }
        if (normalized === '/aprovar' || normalized === '/negar') {
          if (!selected?.conversationId) { await respond(sender, 'Selecione o chat da aprovação: /chats'); return; }
          const ref = state.approvalRefs[sender];
          const short = /^\d{1,2}$/.test(arg) && Number(arg) >= 1 && Number(arg) <= 12;
          if (short && (!ref || Date.now() - ref.at >= APPROVAL_REF_MS || ref.sessionId !== selected.id || ref.conversationId !== selected.conversationId)) {
            const cards = deps.approvals().filter(item => item.conversationId === selected.conversationId && !item.outcome);
            rememberCards(state, sender, selected, cards);
            await commit(state);
            await respond(sender, cards.length ? `O código ainda não estava vinculado a um cartão. Confira e envie o comando novamente:\n${displayCards(selected, cards)}` : 'Nenhuma aprovação pendente no chat selecionado.');
            return;
          }
          const cardId = short && ref && Date.now() - ref.at < APPROVAL_REF_MS && ref.sessionId === selected.id &&
            ref.conversationId === selected.conversationId ? ref.cardIds[Number(arg) - 1] : short ? null : arg;
          const card = deps.approvals().find(item => item.conversationId === selected.conversationId && item.cardId === cardId && !item.outcome);
          if (!card || (normalized === '/aprovar' && !card.allow)) { await respond(sender, 'Cartão ausente, expirado ou não autorizado. Use /aprovacoes novamente.'); return; }
          await decide(sender, state, card, normalized === '/aprovar' ? 'allow' : 'deny');
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
        if (!await authorized(sender)) return;
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
          if (!await respond(sender, 'Resposta de Chat Marks:\n' + latest.text)) continue;
          delete state.pending[sender]; dirty = true;
          if (state.selected[sender] === pending.sessionId) {
            state.mirrored[sender] = { sessionId: pending.sessionId, seq: latest.seq, id: latest.id };
          }
          await commit(state);
        }
        // Explicit /usar selection also subscribes this phone to future desktop
        // replies. Never replay the previous chat history on first subscription.
        const sessions = await available();
        for (const [sender, sessionId] of Object.entries(state.selected)) {
          if (state.pending[sender] || !await authorized(sender) || !sessions.some(s => s.id === sessionId)) continue;
          const latest = await deps.latest(sessionId).catch(() => null);
          const marker = state.mirrored[sender];
          if (!marker || marker.sessionId !== sessionId) {
            state.mirrored[sender] = { sessionId, seq: latest?.seq ?? 0, id: latest?.id ?? '' };
            dirty = true;
            continue;
          }
          const answers = deps.completedSince
            ? await deps.completedSince(sessionId, marker.seq).catch(() => [])
            : latest && latest.seq > marker.seq ? [latest] : [];
          for (const answer of answers.sort((a,b)=>a.seq-b.seq)) {
            if (answer.seq <= state.mirrored[sender]!.seq) continue;
            if (!await respond(sender, 'Resposta de Chat Marks:\n' + answer.text)) break;
            state.mirrored[sender] = { sessionId, seq: answer.seq, id: answer.id };
            dirty = true;
            await commit(state);
          }
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
          if (await approvalReceipt(sender, state)) continue;
          const selected = await target(sender, state, sessions);
          if (!selected?.conversationId) continue;
          const card = deps.approvals().find(item => item.conversationId === selected.conversationId && !item.outcome);
          if (!card) {
            const ref = state.approvalRefs[sender];
            const awaitingHost = ref?.conversationId === selected.conversationId &&
              ref.sessionId === selected.id && Date.now() - ref.at < APPROVAL_REF_MS &&
              ref.cardIds.some(cardId => {
                const phase = deps.approvalStatus?.(ref.conversationId, cardId);
                return phase === 'pending' || phase === 'clicked';
              });
            if (!awaitingHost) {
              delete state.alerts[sender];
              delete state.approvalRefs[sender];
            }
            continue;
          }
          const fingerprint = `${card.conversationId}:${card.cardId}`;
          const ref = state.approvalRefs[sender];
          if (ref?.conversationId === card.conversationId && ref.cardIds[0] === card.cardId &&
              deps.approvalStatus?.(card.conversationId, card.cardId) === 'pending') continue;
          if (state.alerts[sender] === fingerprint && ref?.cardIds[0] === card.cardId &&
              ref.sessionId === selected.id && Date.now() - ref.at < APPROVAL_REF_MS) continue;
          rememberCards(state, sender, selected, [card]);
          await commit(state);
          if (!await respond(sender, displayCards(selected, [card]))) continue;
          state.alerts[sender] = fingerprint;
          await commit(state);
        }
        await commit(state);
      });
    },
    approvalCode(number, conversationId, cardId) {
      let code: string | null = null;
      return serial(async () => {
        if (!await authorized(number) || !conversationId || conversationId.length > 256 || !cardId || cardId.length > 256) return;
        const state = await get();
        const now = Date.now();
        const refs = (state.directRefs[number] ?? []).filter(ref => now - ref.at < APPROVAL_REF_MS);
        const same = refs.find(ref => ref.conversationId === conversationId && ref.cardId === cardId && !ref.decided);
        if (same) { same.at = now; code = same.code; }
        else {
          const used = new Set(refs.map(ref => ref.code));
          let next: string;
          do next = String(randomInt(1000, 10000)); while (used.has(next));
          refs.push({ code: next, conversationId, cardId, at: now, decided: false });
          code = next;
        }
        state.directRefs[number] = refs.slice(-DIRECT_LIMIT);
        await commit(state);
      }).then(() => code);
    }
  };
}

export function completedWhatsAppAnswers(
  messages: readonly {kind:string;turnId?:string;final?:boolean;time:number;seq:number;messageId?:string;message?:{text:string}}[],
  boundaries: readonly {kind:string;turnId?:string;outcome?:string;time:number;seq:number}[],
  afterSeq:number
): Array<{id:string;seq:number;text:string}> {
  const completed = new Map(boundaries.filter(e=>e.kind==='turn_end' && e.outcome==='completed' && e.turnId)
    .map(e=>[e.turnId!,e.time]));
  return messages.filter(e=>e.kind==='assistant_message' && e.final && e.turnId &&
    completed.has(e.turnId) && e.time<=completed.get(e.turnId)! && e.seq>afterSeq && !!e.message?.text?.trim())
    .sort((a,b)=>a.seq-b.seq).map(e=>({id:`${e.seq}:${e.messageId??''}`,seq:e.seq,text:e.message!.text}));
}

/** Reads the last finished answer even if another turn has already started.
 * A streaming bubble is not terminal; a stale answer after the finish boundary is not relayed.
 */
export function lastRelayableWhatsAppAnswer(
  events: readonly { kind: string; final?: boolean; state?: string; time: number; seq: number; messageId?: string; message?: { text: string } }[],
  completedAt: number | null
): { id: string; seq: number; text: string } | null {
  if (completedAt === null) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const item = events[i]!;
    if (item.kind !== 'assistant_message' || !item.final || item.time > completedAt ||
        !item.message?.text?.trim()) continue;
    return { id: `${item.seq}:${item.messageId ?? ''}`, seq: item.seq, text: item.message.text };
  }
  return null;
}
