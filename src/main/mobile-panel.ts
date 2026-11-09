/**
 * Opt-in mobile control panel. This listener is absent by default. A remote bind
 * requires operator-supplied TLS; neither the bridge nor the user's browser
 * account credentials are exposed to the LAN.
 *
 * Authenticated approval clicks only queue an exact-card user decision. The
 * ChatGPT page must still match and accept it; this server never grants tools.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import https from 'node:https';
import { isIP, type AddressInfo } from 'node:net';
import path from 'node:path';

export interface MobilePanelData {
  sessions: Array<{ id: string; title: string; updatedAt: number; state: string; conversationId: string | null }>;
  company: { name: string; demo: boolean; seats: Array<{ seat: string; state: string; tickets: number }>; requests: Array<{ title: string; status: string; seat: string | null }> };
  approvals: Array<{ conversationId: string; cardId: string; title: string; choiceEnabled: boolean; outcome: string | null }>;
}
export interface MobilePanelDeps {
  snapshot(): Promise<MobilePanelData>;
  answer(conversationId: string, cardId: string, choice: 'allow' | 'deny'): { ok: true } | { ok: false; error: string };
  history?(sessionId: string): Promise<Array<{seq:number;kind:'user'|'assistant';text:string}>>;
  send?(sessionId: string, text: string): Promise<{id:string;state:string}>;
}
export interface MobilePanelOptions {
  userData: string;
  host?: string;
  port?: number;
  tlsCert?: string;
  tlsKey?: string;
}
export interface MobilePanelInstance {
  address: string;
  stop(): Promise<void>;
}
const PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Chat Marks · Painel</title><link rel="stylesheet" href="/mobile.css"></head><body><main><header><h1>Chat Marks</h1><p>Central mobile · sessão local autenticada</p></header><section class="login"><label for="token">Código de acesso do computador</label><div class="inline"><input id="token" type="password" autocomplete="off" placeholder="Código privado"><button id="login">Entrar</button></div><p id="message" role="status" aria-live="polite">Acesso desativado sem o código gerado pelo Chat Marks.</p></section><section id="dashboard" hidden><div class="inline"><h2>Visão geral</h2><button id="refresh">Atualizar</button><button id="logout">Sair</button></div><p id="last-update"></p><h2>Aprovações pendentes</h2><div id="approvals"></div><h2>Empresa</h2><div id="company"></div><h2>Conversas recentes</h2><div id="sessions"></div><section id="selected-chat" hidden><h2 id="chat-title">Conversa selecionada</h2><div id="history" role="log" aria-live="polite"></div><label for="reply">Mensagem para esta conversa</label><textarea id="reply" rows="3" maxlength="1600" placeholder="Digite uma mensagem"></textarea><button id="send" type="button">Enviar à conversa</button><p class="meta">Aceite na fila não significa entrega ou resposta concluída.</p></section></section><footer>A aprovação é encaminhada ao aplicativo. Somente o ChatGPT pode confirmar a permissão final.</footer></main><script src="/mobile.js" defer></script></body></html>`;
const CSS = `:root{color-scheme:dark;font:16px system-ui,sans-serif;background:#121a24;color:#f0f4f9}*{box-sizing:border-box}body{margin:0}main{width:min(850px,100%);margin:auto;padding:22px}header{padding:12px 0 20px}h1{margin:0;font-size:2rem}h2{font-size:1.22rem;margin:26px 0 10px}p{color:#b7c6d9;line-height:1.5}.inline{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.inline h2{flex:1}input,textarea{min-width:140px;flex:1;padding:13px;background:#26364a;border:1px solid #526982;border-radius:10px;color:inherit;font:inherit}textarea{width:100%;resize:vertical}button{background:#346da9;border:1px solid #6493c5;color:#fff;border-radius:10px;padding:11px 14px;font:inherit;cursor:pointer}button:hover{background:#4586c8}button:disabled{opacity:.5;cursor:default}.card{padding:15px;border:1px solid #35485f;background:#1d2939;border-radius:12px;margin:9px 0;overflow-wrap:anywhere}.card strong{display:block}.meta{font-size:.85rem;color:#b7c6d9}.login{background:#1c2937;border-radius:14px;padding:17px}.actions{display:flex;gap:8px;margin-top:12px}.deny{background:#613d46}footer{border-top:1px solid #35485f;margin-top:30px;padding:20px 0;color:#a7b8c9;font-size:.85rem}@media(max-width:500px){main{padding:14px}button{min-height:45px}}`;
const JS = `(() => {
  'use strict';
  let token = '';
  let selectedSession = '';
  const $ = id => document.getElementById(id);
  const message = text => { $('message').textContent = text; };
  function card(title, details, buttons) {
    const box = document.createElement('article'); box.className = 'card';
    const heading = document.createElement('strong'); heading.textContent = title;
    const meta = document.createElement('p'); meta.className = 'meta'; meta.textContent = details;
    box.append(heading, meta);
    if (buttons) box.append(buttons);
    return box;
  }
  async function api(route, method, payload) {
    const response = await fetch(route, { method, cache: 'no-store', credentials: 'omit',
      headers: { Authorization: 'Bearer ' + token, ...(payload ? {'Content-Type':'application/json'} : {}) },
      ...(payload ? {body: JSON.stringify(payload)} : {}) });
    if (!response.ok) throw Error(response.status === 401 ? 'Código de acesso inválido.' : 'Não foi possível concluir a solicitação (' + response.status + ').');
    return response.json();
  }
  async function openChat(session) {
    selectedSession = session.id;
    $('selected-chat').hidden = false;
    $('chat-title').textContent = session.title;
    $('history').replaceChildren();
    try {
      const data = await api('/api/chat/' + encodeURIComponent(session.id), 'GET');
      if (selectedSession !== session.id) return;
      for (const row of data.messages) {
        $('history').append(card(row.kind === 'assistant' ? 'Chat Marks' : 'Você', row.text));
      }
      if (!data.messages.length) $('history').append(card('Sem mensagens recentes', 'Nada registrado neste histórico.'));
    } catch (error) { message(error.message); }
  }
  async function refresh() {
    try {
      const data = await api('/api/status', 'GET');
      $('dashboard').hidden = false;
      $('last-update').textContent = 'Atualizado ' + new Date().toLocaleTimeString('pt-BR');
      const approvals = $('approvals'); approvals.replaceChildren();
      for (const a of data.approvals) {
        const actions = document.createElement('div'); actions.className = 'actions';
        for (const choice of ['allow','deny']) {
          if (choice === 'allow' && !a.choiceEnabled) continue;
          if (a.outcome) continue;
          const b = document.createElement('button'); b.textContent = choice === 'allow' ? 'Permitir uma vez' : 'Negar';
          if (choice === 'deny') b.className = 'deny';
          b.addEventListener('click', async () => {
            b.disabled = true;
            try {
              await api('/api/approval', 'POST', {conversationId:a.conversationId,cardId:a.cardId,choice});
              message('Decisão enviada. Aguarde confirmação do ChatGPT no computador.');
              await refresh();
            } catch (e) { message(e.message); b.disabled = false; }
          });
          actions.append(b);
        }
        approvals.append(card(a.title, a.outcome ? 'Estado no host: ' + a.outcome : 'Requer decisão humana · confirmação externa pendente',actions));
      }
      if (!data.approvals.length) approvals.append(card('Nenhuma aprovação pendente','O aplicativo não registrou solicitações recentes.'));
      const company = $('company'); company.replaceChildren();
      company.append(card(data.company.name, data.company.demo ? 'Demonstração · não são trabalhadores reais' : 'Empresa real · estado do broker não atestado neste painel'));
      for (const seat of data.company.seats) company.append(card(seat.seat, seat.state + ' · ' + seat.tickets + ' solicitações atribuídas'));
      const sessions = $('sessions'); sessions.replaceChildren();
      for (const item of data.sessions) {
        const actions = document.createElement('div'); actions.className = 'actions';
        if (item.conversationId) {
          const button = document.createElement('button'); button.textContent = 'Abrir conversa';
          button.addEventListener('click', () => void openChat(item)); actions.append(button);
        }
        sessions.append(card(item.title,item.state + ' · ' + new Date(item.updatedAt).toLocaleString('pt-BR'),actions));
      }
      if (!data.sessions.length) sessions.append(card('Nenhuma conversa','Sem sessões registradas.'));
      if (selectedSession && !data.sessions.some(item => item.id === selectedSession && item.conversationId)) {
        selectedSession = ''; $('selected-chat').hidden = true; $('history').replaceChildren();
      }
    } catch (e) { message(e.message); if (String(e.message).includes('inválido')) {token='';$('dashboard').hidden=true;} }
  }
  $('login').addEventListener('click', async () => {
    token = $('token').value.trim(); $('token').value = '';
    if (!token) { message('Informe o código de acesso.'); return; }
    await refresh();
  });
  $('refresh').addEventListener('click', refresh);
  $('send').addEventListener('click', async () => {
    if (!selectedSession || !$('reply').value.trim()) return;
    const send = $('send'); send.disabled = true;
    try {
      const result = await api('/api/chat/send', 'POST', {sessionId:selectedSession,text:$('reply').value});
      $('reply').value = '';
      message('Mensagem ' + result.state + ' na fila local. Ainda sem confirmação de entrega.');
    } catch (error) { message(error.message); }
    finally { send.disabled = false; }
  });
  $('logout').addEventListener('click', () => {token='';selectedSession='';$('reply').value='';$('history').replaceChildren();$('selected-chat').hidden=true;$('dashboard').hidden=true;message('Sessão encerrada neste navegador.');});
})();`;
const MAX_BODY = 2048;
function security(res: ServerResponse): void {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'");
}
function respond(res: ServerResponse, status: number, body: string, mime = 'application/json; charset=utf-8'): void {
  security(res); res.writeHead(status, { 'Content-Type': mime }); res.end(body);
}
function endpointHost(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(`http://${raw}`);
    if (!url.hostname || !isIP(url.hostname.replace(/^\[|\]$/g, ''))) return null;
    return raw;
  } catch { return null; }
}
function equalToken(input: string | undefined, secret: Buffer): boolean {
  if (!input?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(input.slice(7));
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
}
async function body(req: IncomingMessage): Promise<unknown> {
  let value = '';
  for await (const chunk of req) {
    value += String(chunk);
    if (Buffer.byteLength(value) > MAX_BODY) throw Error('large_body');
  }
  return JSON.parse(value);
}
export async function startMobilePanel(opts: MobilePanelOptions, deps: MobilePanelDeps): Promise<MobilePanelInstance> {
  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? 17893;
  if (!isIP(host) || !Number.isInteger(port) || port < 0 || port > 65535) throw Error('Invalid mobile panel listener');
  const loopback = host === '127.0.0.1' || host === '::1';
  if (!loopback && (!opts.tlsCert || !opts.tlsKey)) throw Error('Mobile LAN requires explicit TLS certificate and key');
  const ssl = !loopback ? { cert: await fs.readFile(opts.tlsCert!), key: await fs.readFile(opts.tlsKey!) } : null;
  if (ssl && (ssl.cert.length > 65536 || ssl.key.length > 65536)) throw Error('Invalid mobile TLS file');
  const root = path.join(opts.userData, 'mobile-panel');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await fs.lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error('Invalid mobile panel directory');
  const token = randomBytes(32).toString('hex');
  const secret = Buffer.from(token);
  const requests = new Map<string, { from: number; count: number }>();
  const server = (ssl ? https.createServer(ssl) : http.createServer());
  server.maxConnections = 16;
  server.requestTimeout = 5_000;
  server.headersTimeout = 8_000;
  server.on('request', (req, res) => { void (async () => {
    const authority = endpointHost(req.headers.host);
    const socketIp = (req.socket.localAddress || '').replace(/^::ffff:/, '');
    const hostName = authority ? new URL('http://' + authority).hostname.replace(/^\[|\]$/g, '') : '';
    const expectedPort = (server.address() as AddressInfo).port;
    const actualPort = authority ? Number(new URL('http://' + authority).port || (ssl ? 443 : 80)) : 0;
    if (!authority || actualPort !== expectedPort || (hostName !== socketIp && !(loopback && hostName === host))) {
      respond(res, 403, '{"error":"host_denied"}'); return;
    }
    const expectedOrigin = (ssl ? 'https://' : 'http://') + authority;
    if (req.headers.origin && req.headers.origin !== expectedOrigin) { respond(res, 403, '{"error":"origin_denied"}'); return; }
    const route = (req.url || '').split('?')[0] ?? '';
    if (req.url?.includes('?')) { respond(res, 400, '{"error":"query_denied"}'); return; }
    if (req.method === 'GET' && route === '/') { respond(res, 200, PAGE, 'text/html; charset=utf-8'); return; }
    if (req.method === 'GET' && route === '/mobile.css') { respond(res, 200, CSS, 'text/css; charset=utf-8'); return; }
    if (req.method === 'GET' && route === '/mobile.js') { respond(res, 200, JS, 'text/javascript; charset=utf-8'); return; }
    const ip = req.socket.remoteAddress ?? 'unknown'; const now = Date.now();
    const quota = requests.get(ip);
    if (quota && now - quota.from < 60_000 && quota.count >= 120) { respond(res, 429, '{"error":"rate_limit"}'); return; }
    requests.set(ip, { from: quota && now - quota.from < 60_000 ? quota.from : now, count: (quota && now - quota.from < 60_000 ? quota.count : 0) + 1 });
    if (!equalToken(req.headers.authorization, secret)) { respond(res, 401, '{"error":"not_authorized"}'); return; }
    if (req.method === 'GET' && route === '/api/status') {
      respond(res, 200, JSON.stringify(await deps.snapshot())); return;
    }
    if (req.method === 'GET' && route.startsWith('/api/chat/')) {
      const id = route.slice('/api/chat/'.length);
      const snapshot = await deps.snapshot();
      if (!deps.history || !snapshot.sessions.some(session => session.id === id && session.conversationId)) {
        respond(res, 404, '{"error":"session_not_available"}'); return;
      }
      respond(res, 200, JSON.stringify({sessionId:id,messages:(await deps.history(id)).slice(-40)})); return;
    }
    if (req.method === 'POST' && route === '/api/chat/send') {
      if (req.headers.origin !== expectedOrigin || req.headers['content-type'] !== 'application/json') {
        respond(res, 403, '{"error":"action_origin_denied"}'); return;
      }
      const parsed = await body(req) as Record<string,unknown>;
      if (!parsed || Object.keys(parsed).sort().join(',') !== 'sessionId,text' ||
          typeof parsed.sessionId !== 'string' || typeof parsed.text !== 'string' ||
          !parsed.text.trim() || parsed.text.length > 1600 || !deps.send) {
        respond(res, 400, '{"error":"invalid_request"}'); return;
      }
      const snapshot = await deps.snapshot();
      if (!snapshot.sessions.some(session => session.id === parsed.sessionId && session.conversationId)) {
        respond(res, 404, '{"error":"session_not_available"}'); return;
      }
      respond(res, 202, JSON.stringify(await deps.send(parsed.sessionId,parsed.text.trim()))); return;
    }
    if (req.method === 'POST' && route === '/api/approval') {
      // Browsers send Origin on POST. Require it, and a matching non-credential
      // host; this is an explicit single-card click, not durable authorization.
      if (req.headers.origin !== expectedOrigin || req.headers['content-type'] !== 'application/json') {
        respond(res, 403, '{"error":"action_origin_denied"}'); return;
      }
      const parsed = await body(req) as Record<string,unknown>;
      if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).sort().join(',') !== 'cardId,choice,conversationId' ||
          typeof parsed.conversationId !== 'string' || !/^[A-Za-z0-9_-]{5,160}$/.test(parsed.conversationId) ||
          typeof parsed.cardId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(parsed.cardId) ||
          (parsed.choice !== 'allow' && parsed.choice !== 'deny')) {
        respond(res, 400, '{"error":"invalid_request"}'); return;
      }
      // Reconcile against the live card after authentication, not just against
      // syntax. A guessed/stale card id must never be delegated to the host.
      const snapshot = await deps.snapshot();
      const exact = snapshot.approvals.find(item => item.conversationId === parsed.conversationId &&
        item.cardId === parsed.cardId && !item.outcome);
      if (!exact || (parsed.choice === 'allow' && !exact.choiceEnabled)) {
        respond(res, 409, '{"error":"approval_not_current"}'); return;
      }
      const result = deps.answer(parsed.conversationId,parsed.cardId,parsed.choice);
      respond(res, result.ok ? 202 : 409, JSON.stringify(result)); return;
    }
    respond(res, 404, '{"error":"not_found"}');
  })().catch(() => respond(res, 400, '{"error":"invalid_request"}')); });
  let listening = false;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
    });
    listening = true;
    const address = (server.address() as AddressInfo).port;
    const tmp = path.join(root, '.token.' + randomBytes(5).toString('hex'));
    try {
      await fs.writeFile(tmp, token + '\n', { flag: 'wx', mode: 0o600 });
      await fs.rename(tmp, path.join(root, 'access.token'));
    } finally { await fs.rm(tmp, { force: true }); }
    return {
      address: `${ssl ? 'https' : 'http'}://${host.includes(':') ? '['+host+']' : host}:${address}`,
      stop: async () => {
        await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
        await fs.rm(path.join(root, 'access.token'), { force: true });
      }
    };
  } catch (error) {
    if (listening) await new Promise<void>(resolve => server.close(() => resolve()));
    throw error;
  }
}
