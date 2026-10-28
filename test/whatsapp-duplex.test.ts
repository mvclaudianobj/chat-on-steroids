import { describe, expect, it, vi } from 'vitest';
import { createWhatsAppDuplex, lastRelayableWhatsAppAnswer, completedWhatsAppAnswers } from '../src/main/whatsapp-duplex.js';

const sessions = [
  { id: 'session-first-123', title: 'Projeto Alpha', conversationId: 'chat-alpha', updatedAt: 30 },
  { id: 'session-second-456', title: 'Projeto Beta', conversationId: 'chat-beta', updatedAt: 20 }
];
const sender = '5511999999999';
function setup(enabled = true) {
  let state: unknown = null;
  let latest: { id: string; text: string; seq: number } | null = { id: 'prior-1', text: 'Anterior', seq: 1 };
  let deliverySeq: number | null = 5;
  let cards = [{ conversationId: 'chat-alpha', cardId: 'card-specific-1', title: 'Projeto Alpha', allow: true, outcome: null as string | null }];
  const sendText = vi.fn(async (_number: string, _text: string) => {});
  const send = vi.fn(async () => ({ id: 'queued-1', state: 'queued' }));
  const answer = vi.fn(() => ({ ok: true as const }));
  const duplex = createWhatsAppDuplex({
    allowed: async () => enabled ? [sender] : [],
    sessions: async () => sessions,
    active: async () => sessions[0]!.id,
    sendText, send,
    approvals: () => cards,
    answer,
    latest: async () => latest,
    delivered: async () => deliverySeq,
    load: async () => state,
    save: async value => { state = structuredClone(value); }
  });
  return { duplex, sendText, send, answer, setLatest: (value: { id: string; text: string; seq: number }) => { latest = value; }, setDelivery: (value: number | null) => { deliverySeq = value; }, setCards: (value: typeof cards) => { cards = value; }, getState: () => state };
}
describe('WhatsApp bidirectional owner-only routing', () => {
  it('reports only the allowlisted sender\'s latest outgoing delivery phase via /estado', async () => {
    const sent = vi.fn(async (_number: string, _text: string) => undefined);
    const duplex = createWhatsAppDuplex({
      allowed: async () => [sender], sessions: async () => sessions, active: async () => null,
      sendText: sent, send: async () => ({ id: 'input', state: 'queued' }),
      approvals: () => [], answer: () => ({ ok: false as const, error: 'no-card' }),
      latest: async () => null, delivered: async () => null,
      deliveryStatus: number => number === sender ? 'delivered' : null,
      load: async () => null, save: async () => undefined
    });
    await duplex.incoming(sender, 'delivery-command-1', '/estado');
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent.mock.calls[0]![1]).toContain('entrega');
    await duplex.incoming('5511888888888', 'unauthorized-status', '/estado');
    expect(sent).toHaveBeenCalledTimes(1);
  });
  it('collects every new completed reply between 8-second polls without relaying streaming or aborted turns', () => {
    const messages = [
      {kind:'assistant_message',turnId:'turn-1',final:true,seq:10,time:100,messageId:'m1',message:{text:'final 1'}},
      {kind:'assistant_message',turnId:'turn-2',final:true,seq:12,time:150,messageId:'m2',message:{text:'final 2'}},
      {kind:'assistant_message',turnId:'turn-3',final:false,seq:14,time:190,messageId:'m3',message:{text:'partial'}},
      {kind:'assistant_message',turnId:'turn-4',final:true,seq:16,time:195,messageId:'m4',message:{text:'interrupted'}}
    ];
    const ends=[
      {kind:'turn_end',turnId:'turn-1',outcome:'completed',seq:11,time:110},
      {kind:'turn_end',turnId:'turn-2',outcome:'completed',seq:13,time:160},
      {kind:'turn_end',turnId:'turn-4',outcome:'interrupted',seq:17,time:210}
    ];
    expect(completedWhatsAppAnswers(messages,ends,9).map(r=>r.text)).toEqual(['final 1','final 2']);
    expect(completedWhatsAppAnswers(messages,ends,10).map(r=>r.text)).toEqual(['final 2']);
  });
  it('mirrors all completed answers since the last acknowledged sequence in order', async () => {
    let saved: unknown = null;
    const sendText=vi.fn(async (_number:string,_text:string)=>undefined);
    let answers=[{id:'baseline',seq:1,text:'old answer'}];
    const duplex=createWhatsAppDuplex({
      allowed:async()=>[sender],sessions:async()=>sessions,active:async()=>sessions[0]!.id,
      sendText,send:async()=>({id:'x',state:'queued'}),approvals:()=>[],answer:()=>({ok:false as const,error:'none'}),
      latest:async()=>answers.at(-1)??null,
      completedSince:async(_sid,after)=>answers.filter(a=>a.seq>after),
      delivered:async()=>null,load:async()=>saved,save:async value=>{saved=structuredClone(value)}
    });
    await duplex.incoming(sender,'pick','/usar 1');
    sendText.mockClear();
    answers=[...answers,{id:'a',seq:2,text:'first new'},{id:'b',seq:3,text:'second new'}];
    await duplex.changed([]);await duplex.changed([]);
    expect(sendText.mock.calls.map(c=>c[1])).toEqual(['Resposta de Chat Marks:\nfirst new','Resposta de Chat Marks:\nsecond new']);
  });
  it('recognizes last completed answer even when the next turn is already streaming', () => {
    const events = [
      { kind: 'assistant_message', final: true, time: 200, seq: 10, messageId: 'done', message: { text: 'Resposta final' } },
      { kind: 'assistant_message', final: false, time: 305, seq: 14, messageId: 'stream', message: { text: 'Parcial não enviado' } }
    ];
    expect(lastRelayableWhatsAppAnswer(events, 250)).toMatchObject({ seq: 10, text: 'Resposta final' });
    expect(lastRelayableWhatsAppAnswer(events, null)).toBeNull();
    expect(lastRelayableWhatsAppAnswer([events[1]!], 250)).toBeNull();
    expect(lastRelayableWhatsAppAnswer([{ ...events[0]!, time: 280 }], 250)).toBeNull();
  });
  it('mirrors new desktop final answers to explicitly selected phone once, not historical answers', async () => {
    const app = setup();
    await app.duplex.incoming(sender, 'choose', '/usar 1');
    app.sendText.mockClear();
    await app.duplex.changed([]);
    expect(app.sendText).not.toHaveBeenCalled();
    app.setLatest({ id: 'later-final', text: 'Respondido aqui no Chat Marks', seq: 29 });
    await app.duplex.changed([]);
    await app.duplex.changed([]);
    expect(app.sendText).toHaveBeenCalledTimes(1);
    expect(app.sendText.mock.calls[0]![1]).toContain('Respondido aqui no Chat Marks');
    expect(JSON.stringify(app.getState())).not.toContain('Respondido aqui no Chat Marks');
  });
  it('keeps a desktop final reply pending if WhatsApp send fails, then retries without duplicates', async () => {
    const app = setup();
    await app.duplex.incoming(sender, 'choose', '/usar 1');
    app.sendText.mockClear();
    app.setLatest({ id: 'new-final', text: 'Retorno confirmado', seq: 34 });
    app.sendText.mockRejectedValueOnce(new Error('synthetic WhatsApp outage'));
    await expect(app.duplex.changed([])).rejects.toThrow('synthetic');
    await app.duplex.changed([]);
    await app.duplex.changed([]);
    expect(app.sendText).toHaveBeenCalledTimes(2);
    expect(app.sendText.mock.calls[1]![1]).toContain('Retorno confirmado');
  });
  it('advertises one-digit exact-card approval and rejects card replacements or replay', async () => {
    const app = setup();
    await app.duplex.incoming(sender, 'choose', '/usar 1');
    app.sendText.mockClear();
    await app.duplex.incoming(sender, 'show', '/aprovacoes');
    expect(app.sendText.mock.calls.at(-1)![1]).toContain('/aprovar 1');
    expect(app.sendText.mock.calls.at(-1)![1]).not.toContain('card-specific-1');
    app.setCards([{ conversationId: 'chat-alpha', cardId: 'new-card', title: 'Projeto Alpha', allow: true, outcome: null }]);
    await app.duplex.incoming(sender, 'stale', '/aprovar 1');
    expect(app.answer).not.toHaveBeenCalled();
    await app.duplex.incoming(sender, 'refresh', '/aprovacoes');
    await app.duplex.incoming(sender, 'permit', '/aprovar 1');
    expect(app.answer).toHaveBeenCalledExactlyOnceWith('chat-alpha', 'new-card', 'allow');
    await app.duplex.incoming(sender, 'replayed-different-id', '/aprovar 1');
    expect(app.answer).toHaveBeenCalledTimes(1);
  });
  it('FAIL-FIRST: /aprovar 1 without an advertised mapping shows the exact card instead of silently failing', async () => {
    const app = setup();
    await app.duplex.incoming(sender, 'choose', '/usar 1');
    app.sendText.mockClear();
    await app.duplex.incoming(sender, 'first-approval-attempt', '/aprovar 1');
    expect(app.answer).not.toHaveBeenCalled();
    expect(app.sendText.mock.calls.at(-1)![1]).toContain('/aprovar 1');
    await app.duplex.incoming(sender, 'second-approval-attempt', '/aprovar 1');
    expect(app.answer).toHaveBeenCalledExactlyOnceWith('chat-alpha', 'card-specific-1', 'allow');
  });
  it('FAIL-FIRST: reports a verified host card dismissal separately from the WhatsApp forwarding receipt', async () => {
    let outcome: 'pending' | 'dismissed' | null = 'pending';
    let state: unknown = null;
    const sendText = vi.fn(async (_number: string, _text: string) => {});
    const duplex = createWhatsAppDuplex({
      allowed: async () => [sender], sessions: async () => sessions, active: async () => sessions[0]!.id,
      sendText, send: async () => ({ id: 'unused', state: 'queued' }),
      approvals: () => [{ conversationId: 'chat-alpha', cardId: 'card-specific-1', title: 'Synthetic', allow: true, outcome: outcome === 'dismissed' ? 'dismissed' : null }],
      answer: () => ({ ok: true }),
      approvalStatus: () => outcome,
      latest: async () => null, delivered: async () => null,
      load: async () => state, save: async next => { state = structuredClone(next); }
    });
    await duplex.incoming(sender, 'selection', '/usar 1');
    await duplex.incoming(sender, 'list-card', '/aprovacoes');
    await duplex.incoming(sender, 'decide-card', '/aprovar 1');
    sendText.mockClear();
    await duplex.pollApprovals();
    expect(sendText).not.toHaveBeenCalled();
    outcome = 'dismissed';
    await duplex.pollApprovals();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText.mock.calls[0]![1]).toMatch(/cartão.*(retirado|desapareceu)/i);
    expect(sendText.mock.calls[0]![1]).toMatch(/não comprova/i);
    await duplex.pollApprovals();
    expect(sendText).toHaveBeenCalledTimes(1);
  });
  it('allows /negar 1 only for the exact card advertised in an automatic notification', async () => {
    const app = setup();
    await app.duplex.incoming(sender, 'choose', '/usar 1');
    app.sendText.mockClear();
    await app.duplex.pollApprovals();
    expect(app.sendText.mock.calls.at(-1)![1]).toContain('/negar 1');
    expect(app.sendText.mock.calls.at(-1)![1]).not.toContain('card-specific-1');
    await app.duplex.incoming(sender, 'deny-short', '/negar 1');
    expect(app.answer).toHaveBeenCalledExactlyOnceWith('chat-alpha', 'card-specific-1', 'deny');
  });
  it('retains the pending short-card reference after the card leaves the live list, until host outcome is observable', async () => {
    let phase: 'pending' | 'dismissed' = 'pending';
    let stored: any = null;
    let visible = true;
    const sent = vi.fn(async (_n:string, _text:string) => undefined);
    const duplex = createWhatsAppDuplex({
      allowed: async()=>[sender], sessions:async()=>sessions, active:async()=>sessions[0]!.id,
      sendText:sent,send:async()=>({id:'q',state:'queued'}),
      approvals:()=>visible ? [{conversationId:'chat-alpha',cardId:'card-specific-1',title:'Synthetic',allow:true,outcome:null}]:[],
      approvalStatus:()=>phase,
      answer:()=>({ok:true}),latest:async()=>null,delivered:async()=>null,
      load:async()=>stored,save:async state=>{stored=structuredClone(state);}
    });
    await duplex.incoming(sender,'select','/usar 1');
    await duplex.incoming(sender,'list','/aprovacoes');
    await duplex.incoming(sender,'allow','/aprovar 1');
    visible = false;
    sent.mockClear();
    await duplex.pollApprovals();
    expect(stored.approvalRefs[sender]).toBeDefined();
    phase = 'dismissed';
    await duplex.pollApprovals();
    expect(sent.mock.calls.at(-1)?.[1]).toContain('não comprova');
    expect(stored.approvalRefs[sender]).toBeUndefined();
  });
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
    expect(app.sendText.mock.calls.at(-1)![1]).toContain('/aprovar 1');
    await app.duplex.incoming(sender, 'bad', '/aprovar wrong-card');
    expect(app.answer).not.toHaveBeenCalled();
    await app.duplex.incoming(sender, 'valid', '/aprovar card-specific-1');
    expect(app.answer).toHaveBeenCalledWith('chat-alpha', 'card-specific-1', 'allow');
    expect(app.sendText.mock.calls.at(-1)![1]).toMatch(/encaminhada|aguard/i);
  });
});
