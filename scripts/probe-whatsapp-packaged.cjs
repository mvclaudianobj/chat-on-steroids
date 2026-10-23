'use strict';
// No real profile, no network: isolated Node mode in the packaged Electron binary.
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = path.resolve(process.argv[2] || '');
if (!root || !root.includes('linux-unpacked')) process.exit(80);
const mainEntry = path.join(root, 'resources', 'app.asar', 'out', 'main', 'index.js');
const packaged = createRequire(mainEntry);
const classify = error => {
  const code = error && typeof error.code === 'string' ? error.code : 'NO_CODE';
  return /^[A-Z_0-9]{2,64}$/.test(code) ? code : 'REDACTED';
};
(async () => {
  for (const [name, action] of [
    ['qrcode-require', () => packaged('qrcode')],
    ['ws-require', () => packaged('ws')],
    ['baileys-require', () => packaged('@whiskeysockets/baileys')],
    ['baileys-dynamic-import', () => import(pathToFileURL(path.join(root, 'resources', 'app.asar', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'index.js')).href)]
  ]) {
    try { const value = await action(); process.stdout.write(`${name}:ok exports=${typeof value.default}\n`); }
    catch (error) { process.stdout.write(`${name}:failed:${classify(error)} type=${error?.name?.replace(/[^A-Za-z]/g,'')}\n`); process.exitCode = 1; }
  }
})().catch(() => { process.exitCode = 2; });
// Executed after the module availability probe. The fake transport has no network methods.
(async () => {
  const { promises: fs } = require('node:fs');
  const { tmpdir } = require('node:os');
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'marks-qr-pkg-'));
  try {
    const client = await import(pathToFileURL(path.join(root, 'resources', 'app.asar', 'node_modules', '@whiskeysockets', 'baileys', 'lib', 'Socket', 'Client', 'websocket.js')).href);
    let calls = 0;
    client.WebSocketClient.prototype.connect = function () { calls++; };
    const baileys = packaged('@whiskeysockets/baileys');
    const { state } = await baileys.useMultiFileAuthState(dir);
    const logger = {level:'silent', child() {return this}, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}};
    const socket = baileys.default({auth:state,logger,printQRInTerminal:false});
    process.stdout.write(`baileys-new-socket:${calls===1?'ok':'failed'} fake-transport-calls=${calls}\n`);
    if(calls!==1 || !socket.ev) process.exitCode=1;
  } catch (error) {
    const code=error&&typeof error.code==='string'?error.code:'NO_CODE';
    process.stdout.write(`baileys-new-socket:failed:${/^[A-Z_0-9]{2,64}$/.test(code)?code:'REDACTED'} type=${error?.name?.replace(/[^A-Za-z]/g,'')}\n`);
    process.exitCode=1;
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
})().catch(()=>{process.exitCode=2});
