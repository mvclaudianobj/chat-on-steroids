// True Electron main/preload/renderer IPC; fake Baileys transport and disposable app profile.
// No WhatsApp connection, keys, QR payload logs or production resources are opened.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marks-qr-runtime-'));
// Controlled dedicated subdirectory under THIS worktree, separate from every real app profile.
app.setPath('userData', path.join(temp, 'profile'));
app.on('will-quit', () => fs.rmSync(temp, { recursive: true, force: true }));
app.disableHardwareAcceleration();
const compiled = path.join(temp, 'notification-ipc.cjs');
const preload = path.join(temp, 'preload.cjs');
const winName = 'synthetic-ipc-window';
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('testNotify',{call:action=>ipcRenderer.invoke('marksNotify:request',{action})});`);
esbuild.buildSync({ entryPoints: [path.join(root, 'src/main/notification-ipc.ts')], outfile: compiled,
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron', '@whiskeysockets/baileys'], logLevel: 'silent' });
const sockets = [];
const attempts = [];
const noQr = process.env.MARKS_QR_FIXTURE_NOQR === '1';
const normalSetTimeout = global.setTimeout;
// Accelerate only the QR expiry watchdog while preserving Electron/IPC timing.
global.setTimeout = function (callback, delay, ...rest) {
  return normalSetTimeout(callback, delay === 65_000 ? 230 : delay === 25_000 ? 200 : delay === 35_000 && noQr ? 180 : delay, ...rest);
};
const fakeBaileys = {
  __esModule: true,
  DisconnectReason: { loggedOut: 401 },
  useMultiFileAuthState: async () => ({ state: { creds: { registered: false } }, saveCreds: async () => undefined }),
  default: () => {
    const attempt = sockets.length + 1;
    attempts.push({ attempt, startedAt: Date.now(), closes: 0 });
    const socket = { ev: new EventEmitter(), ws: { close: async () => { attempts[attempt - 1].closes++; } }, logout: async () => undefined };
    sockets.push(socket);
    if (!noQr || attempt > 1) setTimeout(() => socket.ev.emit('connection.update', { qr: `SYNTHETIC-NOT-PAIRABLE-${attempt}-A` }), 50);
    if (!noQr && attempt === 1) setTimeout(() => socket.ev.emit('connection.update', { qr: 'SYNTHETIC-NOT-PAIRABLE-1-B' }), 130);
    return socket;
  }
};
const originalLoad = Module._load;
Module._load = function (id, parent, isMain) {
  if (id === '@whiskeysockets/baileys') return fakeBaileys;
  return originalLoad.apply(this, arguments);
};
let register;
try { ({ registerNotificationCenterIpc: register } = require(compiled)); }
finally { Module._load = originalLoad; }
let win;
const guard = setTimeout(() => { console.error('Synthetic IPC smoke timeout'); app.exit(1); }, 18000);
app.whenReady().then(async () => {
  try {
    win = new BrowserWindow({ show: false, width: 600, height: 400,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false } });
    register(() => win);
    await win.loadURL(`data:text/html,<html><body>${winName}</body></html>`);
    const invoke = async action => win.webContents.executeJavaScript(`window.testNotify.call(${JSON.stringify(action)})`);
    const first = await invoke('wa-start');
    console.log('Synthetic start reply:', JSON.stringify({ok:first?.ok,setupCode:first?.setupCode,setupStage:first?.setupStage,state:first?.data?.state}));
    assert.equal(first.ok, true);
    assert(['connecting', 'qr'].includes(first.data.state));
    const until = Date.now() + 3000;
    let reply;
    while (Date.now() < until) {
      reply = await invoke('wa-status');
      if (reply.ok && reply.data.state === (noQr ? 'error' : 'qr')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    console.log('Synthetic status reply:', JSON.stringify({ok:reply?.ok,setupCode:reply?.setupCode,setupStage:reply?.setupStage,state:reply?.data?.state}));
    assert.equal(reply.ok, true);
    if (noQr) {
      assert.equal(reply.data.state, 'error', 'missing QR must time out');
      assert.equal(reply.data.reason, 'qr_timeout');
      assert.equal(reply.data.qr, undefined);
      const autoRetry = process.env.MARKS_QR_FIXTURE_AUTORETRY === '1';
      if (!autoRetry) {
        const second = await invoke('wa-start');
        assert.equal(second.ok, true, 'manual retry must reinitialize after timeout');
      }
      const retryLimit = Date.now() + (autoRetry ? 4400 : 1000);
      while (Date.now() < retryLimit) {
        reply = await invoke('wa-status');
        if (reply.ok && reply.data.state === 'qr') break;
        await new Promise(resolve => normalSetTimeout(resolve, 15));
      }
      assert.equal(reply.data.state, 'qr');
      assert.equal(sockets.length, 2);
      assert.equal(attempts[0].closes, 1);
      assert(reply.data.qr.startsWith('data:image/png;base64,'));
      console.log(`PASS WhatsApp Electron IPC negative:noQR timeout, recovery:${autoRetry ? 'automatic backoff' : 'manual retry'}, sockets=2, closed=1`);
      clearTimeout(guard);
      app.exit(0);
      return;
    }
    assert.equal(reply.data.state, 'qr');
    assert(reply.data.qr.startsWith('data:image/png;base64,'));
    assert.equal(JSON.stringify(reply).includes('SYNTHETIC-NOT-PAIRABLE'), false);
    assert.equal(sockets.length, 1);
    const firstPng = reply.data.qr;
    let rotation;
    const rotationDeadline = Date.now() + 600;
    while (Date.now() < rotationDeadline) {
      rotation = await invoke('wa-status');
      if (rotation.ok && rotation.data.state === 'qr' && rotation.data.qr !== firstPng) break;
      await new Promise(resolve => normalSetTimeout(resolve, 12));
    }
    assert.equal(rotation.ok, true);
    assert.equal(rotation.data.state, 'qr');
    assert.notEqual(rotation.data.qr, firstPng, 'second Baileys QR must replace the first PNG');
    assert.equal(sockets.length, 1, 'normal rotation must not reconnect');
    let expired;
    const expiryDeadline = Date.now() + 900;
    while (Date.now() < expiryDeadline) {
      expired = await invoke('wa-status');
      if (expired.ok && expired.data.state === 'error') break;
      await new Promise(resolve => normalSetTimeout(resolve, 12));
    }
    assert.equal(expired.ok, true);
    assert.equal(expired.data.state, 'error');
    assert.equal(expired.data.reason, 'qr_timeout');
    assert.equal(expired.data.qr, undefined, 'expired QR must disappear from IPC');
    assert.equal(attempts[0].closes, 1, 'stalled socket must close');
    const retryDeadline = Date.now() + 4_200;
    while (Date.now() < retryDeadline && sockets.length < 2) await new Promise(resolve => normalSetTimeout(resolve, 20));
    assert.equal(sockets.length, 2, 'automatic recovery must establish a second socket');
    assert(attempts[1].startedAt - attempts[0].startedAt >= 3_000, 'retry backoff must be respected');
    let recovered;
    const recoverDeadline = Date.now() + 500;
    while (Date.now() < recoverDeadline) {
      recovered = await invoke('wa-status');
      if (recovered.ok && recovered.data.state === 'qr') break;
      await new Promise(resolve => normalSetTimeout(resolve, 12));
    }
    assert.equal(recovered.ok, true);
    assert.equal(recovered.data.state, 'qr');
    assert(recovered.data.qr.startsWith('data:image/png;base64,'));
    console.log('PASS WhatsApp Electron IPC: rotation=2, stale QR removed, auto retry attempts=2, first socket closes=1, minBackoffMs=3000');
    clearTimeout(guard);
    app.exit(0);
  } catch (error) {
    clearTimeout(guard);
    console.error('WhatsApp Electron IPC fixture failed:', error?.name || 'Error');
    app.exit(1);
  }
}).catch(() => app.exit(1));
