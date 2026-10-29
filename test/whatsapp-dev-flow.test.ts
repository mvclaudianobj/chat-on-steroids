/** End-to-end development fixture: Baileys events -> owner menu -> durable Chat Marks
 * admission/receipt -> reply -> exact-card approval, with fake HOME and no network. */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createWhatsAppDuplex } from '../src/main/whatsapp-duplex.js';

const mocks = vi.hoisted(() => ({
  home: '', sockets: [] as Array<{
    ev: import('node:events').EventEmitter; ws: { close: ReturnType<typeof vi.fn> };
    sendMessage: ReturnType<typeof vi.fn>; logout: ReturnType<typeof vi.fn>;
  }>
}));
vi.mock('electron', () => ({ app: { getPath: () => mocks.home } }));
vi.mock('@whiskeysockets/baileys', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    makeWASocket: vi.fn(() => {
      const sock = { ev: new EventEmitter(), ws: { close: vi.fn(() => undefined) }, sendMessage: vi.fn(async () => undefined), logout: vi.fn(async () => undefined) };
      mocks.sockets.push(sock);
      return sock;
    }),
    DisconnectReason: { loggedOut: 401 },
    useMultiFileAuthState: vi.fn(async () => ({ state: { creds: { registered: true } }, saveCreds: vi.fn(async () => undefined) }))
  };
});

const owner = '5511999999999';
const chat = { id: 'dev-chat-0001', title: 'Dev · Autonomia WhatsApp', conversationId: 'native-chat-id', updatedAt: 123 };
type Duplex = ReturnType<typeof createWhatsAppDuplex>;
let web: typeof import('../src/main/notification-whatsapp-web.js');
let duplex: Duplex;
let durable: unknown;
let state: { last: { id: string; text: string; seq: number } | null; deliveredSeq: number | null; queue: Array<{ id: string; text: string }> };
let approve = vi.fn((_conversationId: string, _cardId: string, _choice: 'allow' | 'deny') => ({ ok: true as const }));
let permitted: string[];

function bind(): void {
  duplex = createWhatsAppDuplex({
    allowed: async () => permitted,
    sessions: async () => [chat], active: async () => chat.id,
    sendText: web.sendWhatsAppWeb,
    send: async (sessionId, text) => {
      expect(sessionId).toBe(chat.id);
      const id = `durable-entry-${state.queue.length + 1}`;
      state.queue.push({ id, text });
      return { id, state: 'queued' };
    },
    latest: async () => state.last,
    delivered: async (_session, inputId) => state.queue.some(entry => entry.id === inputId) ? state.deliveredSeq : null,
    approvals: () => [{ conversationId: chat.conversationId!, cardId: 'card-dev-e2e-1', title: chat.title, allow: true, outcome: null }],
    answer: approve,
    load: async () => durable,
    save: async value => { durable = structuredClone(value); }
  });
  web.setWhatsAppWebInbound((from, id, text) => duplex.incoming(from, id, text));
}

async function receive(id: string, text: string, from = owner): Promise<void> {
  const sock = mocks.sockets.at(-1)!;
  sock.ev.emit('messages.upsert', {
    type: 'notify', messages: [{ key: { id, remoteJid: `${from}@s.whatsapp.net`, fromMe: false }, message: { conversation: text } }]
  });
  // EventEmitter listener delegates asynchronously, and a sent WhatsApp message
  // is the observed end-of-step signal. No timers are required for the workflow.
  await vi.waitFor(async () => {
    const saved = durable as { receipts?: string[] } | null;
    expect(saved?.receipts).toContain(`${from}:${id}`);
  });
  await vi.waitFor(() => expect(mocks.sockets.at(-1)!.sendMessage.mock.calls.length).toBeGreaterThan(0));
}

beforeEach(async () => {
  mocks.home = await fs.mkdtemp(path.join(tmpdir(), 'marks-dev-whatsapp-e2e-'));
  mocks.sockets = [];
  durable = null;
  permitted = [owner];
  approve = vi.fn((_conversationId: string, _cardId: string, _choice: 'allow' | 'deny') => ({ ok: true as const }));
  state = { last: null, deliveredSeq: null, queue: [] };
  vi.resetModules();
  web = await import('../src/main/notification-whatsapp-web.js');
  bind();
  await web.startWhatsAppWeb();
  mocks.sockets.at(-1)!.ev.emit('connection.update', { connection: 'open' });
});
afterEach(async () => {
  await web.stopWhatsAppWeb();
  await fs.rm(mocks.home, { recursive: true, force: true });
});

describe('WhatsApp development environment: complete duplex chat', () => {
  it('sends one new desktop reply over Baileys to the explicitly selected WhatsApp phone', async () => {
    const sock = mocks.sockets.at(-1)!;
    await receive('choose-desktop', '/usar 1');
    const count = sock.sendMessage.mock.calls.length;
    state.last = { id: 'completed-desktop-answer', text: 'Mensagem do Chat Marks concluída', seq: 60 };
    await duplex.changed([]);
    await duplex.changed([]);
    expect(sock.sendMessage).toHaveBeenCalledTimes(count + 1);
    expect(sock.sendMessage.mock.calls.at(-1)?.[1]?.text).toContain('Mensagem do Chat Marks concluída');
    expect(sock.sendMessage.mock.calls.at(-1)?.[0]).toBe(`${owner}@s.whatsapp.net`);
  });
  it('menus, selecting chat, queued input, confirmed reply and host-bound one-time approval', async () => {
    const sock = mocks.sockets.at(-1)!;
    await receive('step-1', '/menu');
    await vi.waitFor(() => expect(sock.sendMessage.mock.calls.at(-1)?.[1]?.text).toContain('/chats'));
    await receive('step-2', '/chats');
    await vi.waitFor(() => expect(sock.sendMessage.mock.calls.at(-1)?.[1]?.text).toContain(chat.title));
    await receive('step-3', '/usar 1');
    await vi.waitFor(() => expect(sock.sendMessage.mock.calls.at(-1)?.[1]?.text).toContain('selecionada'));
    await receive('step-4', 'Pode seguir com a implementação?');
    await vi.waitFor(() => expect(state.queue).toEqual([{ id: 'durable-entry-1', text: 'Pode seguir com a implementação?' }]));
    await vi.waitFor(() => expect(sock.sendMessage.mock.calls.at(-1)?.[1]?.text).toContain('enfileirada'));
    const messagesBefore = sock.sendMessage.mock.calls.length;
    state.last = { id: 'unrelated', text: 'Resposta alheia', seq: 3 };
    await duplex.changed([chat.id]);
    expect(sock.sendMessage.mock.calls.length).toBe(messagesBefore);
    state.deliveredSeq = 4;
    state.last = { id: 'our-answer', text: 'Já avancei; execução concluída.', seq: 5 };
    await duplex.changed([chat.id]);
    expect(sock.sendMessage.mock.calls.at(-1)?.[1]?.text).toContain('Já avancei');
    const beforeApproval = sock.sendMessage.mock.calls.length;
    await receive('step-5', '/aprovacoes');
    await vi.waitFor(() => expect(sock.sendMessage.mock.calls.length).toBeGreaterThan(beforeApproval));
    expect(sock.sendMessage.mock.calls.at(-1)?.[1]?.text).toContain('/aprovar 1');
    expect(sock.sendMessage.mock.calls.at(-1)?.[1]?.text).not.toContain('card-dev-e2e-1');
    await receive('step-6', '/aprovar 1');
    await vi.waitFor(() => expect(approve).toHaveBeenCalledWith('native-chat-id', 'card-dev-e2e-1', 'allow'));
    expect(sock.sendMessage.mock.calls.at(-1)?.[1]?.text).toContain('não concede permissão permanente');
  });
  it('duplicate and unauthorized traffic is ignored across an isolated app restart', async () => {
    const sock = mocks.sockets.at(-1)!;
    await receive('original', '/usar 1');
    await receive('message-once', 'Texto enviado uma vez');
    expect(state.queue).toHaveLength(1);
    await web.stopWhatsAppWeb();
    vi.resetModules();
    web = await import('../src/main/notification-whatsapp-web.js');
    bind(); // Restore selected chat + message receipts from durable state.
    await web.startWhatsAppWeb();
    const resumed = mocks.sockets.at(-1)!;
    resumed.ev.emit('connection.update', { connection: 'open' });
    resumed.ev.emit('messages.upsert', { type: 'notify', messages: [
      { key: { id: 'message-once', remoteJid: `${owner}@s.whatsapp.net`, fromMe: false }, message: { conversation: 'Texto enviado uma vez' } },
      { key: { id: 'injection', remoteJid: '5511888888888@s.whatsapp.net', fromMe: false }, message: { conversation: '/chats' } }
    ] });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(state.queue).toHaveLength(1);
    expect(resumed.sendMessage).not.toHaveBeenCalled();
    expect(sock.sendMessage.mock.calls.length).toBeGreaterThan(0);
  });
});
