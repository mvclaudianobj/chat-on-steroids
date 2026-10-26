import { describe, expect, it, vi } from 'vitest';
import { createWhatsAppDuplex } from '../src/main/whatsapp-duplex.js';

const sessions = [
  { id: 'session-first-123', title: 'Projeto Alpha', conversationId: 'chat-alpha', updatedAt: 30 },
  { id: 'session-second-456', title: 'Projeto Beta', conversationId: 'chat-beta', updatedAt: 20 }
];
const sender = '5511999999999';
function setup(enabled = true) {
  let state: unknown = null;
  let latest: { id: string; text: string; seq: number } | null = { id: 'prior-1', text: 'Anterior', seq: 1 };
  let deliverySeq: number | null = 5;
  const sendText = vi.fn(async (_number: string, _text: string) => {});
  const send = vi.fn(async () => ({ id: 'queued-1', state: 'queued' }));
  const answer = vi.fn(() => ({ ok: true as const }));
  const duplex = createWhatsAppDuplex({
    allowed: async () => enabled ? [sender] : [],
    sessions: async () => sessions,
    active: async () => sessions[0]!.id,
    sendText, send,
    approvals: () => [{ conversationId: 'chat-alpha', cardId: 'card-specific-1', title: 'Projeto Alpha', allow: true, outcome: null }],
    answer,
    latest: async () => latest,
    delivered: async () => deliverySeq,
    load: async () => state,
    save: async value => { state = structuredClone(value); }
  });
  return { duplex, sendText, send, answer, setLatest: (value: { id: string; text: string; seq: number }) => { latest = value; }, setDelivery: (value: number | null) => { deliverySeq = value; }, getState: () => state };
}
describe('WhatsApp bidirectional owner-only routing', () => {
  it('does not complete a command after its sender loses authorization during asynchronous session enumeration', async () => {
    let enabled = true;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const sent = vi.fn(async (_number: string, _body: string) => undefined);
    const duplex = createWhatsAppDuplex({
      allowed: async () => enabled ? [sender] : [],
      sessions: async () => { await pending; return sessions; },
      active: async () => sessions[0]!.id,
      sendText: sent,
      send: vi.fn(async () => ({ id: 'never-queued', state: 'queued' })),
      approvals: () => [], answer: () => ({ ok: false as const, error: 'denied' }),
      latest: async () => null, delivered: async () => null,
      load: async () => null, save: async () => undefined
    });
    const command = duplex.incoming(sender, 'revoked-1', '/chats');
    await vi.waitFor(() => expect(sent).not.toHaveBeenCalled());
    enabled = false;
    release();
    await command;
    expect(sent).not.toHaveBeenCalled();
  });
  it('rejects unauthorized sender without replying or exposing sessions', async () => {
    const app = setup();
    await app.duplex.incoming('5511888888888', 'message-1', '/chats');
    expect(app.sendText).not.toHaveBeenCalled();
  });
  it('requires explicit opt-in before any inbound command', async () => {
    const app = setup(false);
    await app.duplex.incoming(sender, 'message-1', '/chats');
    expect(app.sendText).not.toHaveBeenCalled();
  });
  it('lists chats, selects by number, reads active, persists only metadata', async () => {
    const app = setup();
    await app.duplex.incoming(sender, 'message-1', '/chats');
    expect(app.sendText.mock.calls[0]![1]).toContain('Projeto Alpha');
    await app.duplex.incoming(sender, 'message-2', '/usar 2');
    await app.duplex.incoming(sender, 'message-3', '/ativo');
    expect(app.sendText.mock.calls.at(-1)![1]).toContain('Projeto Beta');
    expect(JSON.stringify(app.getState())).not.toContain('Projeto Beta');
  });
  it('queues each unique inbound message once, even when Baileys replays it', async () => {
    const app = setup();
    await app.duplex.incoming(sender, 'select', '/usar 1');
    await Promise.all([app.duplex.incoming(sender, 'unique-1', 'Pode continuar?'), app.duplex.incoming(sender, 'unique-1', 'Pode continuar?')]);
    expect(app.send).toHaveBeenCalledTimes(1);
    expect(app.send).toHaveBeenCalledWith('session-first-123', 'Pode continuar?');
    expect(app.sendText.mock.calls.at(-1)![1]).toMatch(/fila|enfileirad/i);
  });
  it('does not overwrite an outstanding request with another user message before the reply', async () => {
    const app = setup();
    await app.duplex.incoming(sender, 'select', '/usar 1');
    await app.duplex.incoming(sender, 'first', 'Primeiro pedido');
    await app.duplex.incoming(sender, 'second', 'Segundo pedido');
    expect(app.send).toHaveBeenCalledTimes(1);
    expect(app.sendText.mock.calls.at(-1)![1]).toContain('aguardando');
  });
  it('forwards only a newer reply to the sender of the pending chat message', async () => {
    const app = setup();
    await app.duplex.incoming(sender, 'select', '/usar 1');
    await app.duplex.incoming(sender, 'unique-1', 'Responda');
    app.sendText.mockClear();
    await app.duplex.changed(['session-first-123']);
    expect(app.sendText).not.toHaveBeenCalled();
    app.setLatest({ id: 'new-2', text: 'Resposta do ChatGPT', seq: 9 });
    await app.duplex.changed(['session-first-123']);
    await app.duplex.changed(['session-first-123']);
    expect(app.sendText).toHaveBeenCalledTimes(1);
    expect(app.sendText.mock.calls[0]![1]).toContain('Resposta do ChatGPT');
  });
  it('does not attribute an unrelated ongoing turn before proof of exact native user-message delivery', async () => {
    const app = setup();
    await app.duplex.incoming(sender, 'select', '/usar 1');
    await app.duplex.incoming(sender, 'input-1', 'Novo pedido');
    app.sendText.mockClear();
    app.setDelivery(null);
    app.setLatest({ id: 'other-turn', text: 'Resposta alheia', seq: 16 });
    await app.duplex.changed(['session-first-123']);
    expect(app.sendText).not.toHaveBeenCalled();
    app.setDelivery(20);
    await app.duplex.changed(['session-first-123']);
    expect(app.sendText).not.toHaveBeenCalled();
    app.setLatest({ id: 'our-answer', text: 'Resposta correta', seq: 21 });
    await app.duplex.changed(['session-first-123']);
    expect(app.sendText.mock.calls.at(-1)![1]).toContain('Resposta correta');
  });
  it('requires the exact pending approval card and preserves external host authority', async () => {
    const app = setup();
    await app.duplex.incoming(sender, 'select', '/usar 1');
    await app.duplex.incoming(sender, 'show', '/aprovacoes');
    expect(app.sendText.mock.calls.at(-1)![1]).toContain('card-specific-1');
    await app.duplex.incoming(sender, 'bad', '/aprovar wrong-card');
    expect(app.answer).not.toHaveBeenCalled();
    await app.duplex.incoming(sender, 'valid', '/aprovar card-specific-1');
    expect(app.answer).toHaveBeenCalledWith('chat-alpha', 'card-specific-1', 'allow');
    expect(app.sendText.mock.calls.at(-1)![1]).toMatch(/encaminhada|aguard/i);
  });
});
