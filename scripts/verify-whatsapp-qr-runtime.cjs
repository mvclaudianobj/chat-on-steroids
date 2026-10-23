// True Electron main/preload/renderer IPC; fake Baileys transport and disposable app profile.
// No WhatsApp connection, keys, QR payload logs or production resources are opened.
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const temp = path.join(root, '.tmp', 'whatsapp-qr-runtime');
fs.mkdirSync(temp, { recursive: true });
// Controlled dedicated subdirectory under THIS worktree, separate from every real app profile.
app.setPath('userData', path.join(temp, 'profile'));
app.disableHardwareAcceleration();
const compiled = path.join(temp, 'notification-ipc.cjs');
const preload = path.join(temp, 'preload.cjs');
const winName = 'synthetic-ipc-window';
fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('testNotify',{call:action=>ipcRenderer.invoke('marksNotify:request',{action})});`);
esbuild.buildSync({ entryPoints: [path.join(root, 'src/main/notification-ipc.ts')], outfile: compiled,
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron', '@whiskeysockets/baileys'], logLevel: 'silent' });
const sockets = [];
const fakeBaileys = {
  __esModule: true,
  DisconnectReason: { loggedOut: 401 },
  useMultiFileAuthState: async () => ({ state: { creds: { registered: false } }, saveCreds: async () => undefined }),
  default: () => {
    const socket = { ev: new EventEmitter(), ws: { close: async () => undefined }, logout: async () => undefined };
    sockets.push(socket);
    setTimeout(() => socket.ev.emit('connection.update', { qr: 'SYNTHETIC-NOT-PAIRABLE' }), 50);
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
      if (reply.ok && reply.data.state === 'qr') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    console.log('Synthetic status reply:', JSON.stringify({ok:reply?.ok,setupCode:reply?.setupCode,setupStage:reply?.setupStage,state:reply?.data?.state}));
    assert.equal(reply.ok, true);
    assert.equal(reply.data.state, 'qr');
    assert(reply.data.qr.startsWith('data:image/png;base64,'));
    assert.equal(JSON.stringify(reply).includes('SYNTHETIC-NOT-PAIRABLE'), false);
    assert.equal(sockets.length, 1);
    console.log('PASS WhatsApp real Electron IPC: main frame, preload, QR PNG, fake socket, no QR payload');
    clearTimeout(guard);
    app.exit(0);
  } catch (error) {
    clearTimeout(guard);
    console.error('WhatsApp Electron IPC fixture failed:', error?.name || 'Error');
    app.exit(1);
  }
}).catch(() => app.exit(1));
