'use strict';
/** Disposable unauthenticated QR handshake probe. Never prints QR, session data, or exception text. */
const { promises: fs } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
if (process.env.MARKS_EPHEMERAL_QR_PROBE !== 'enabled') {
  process.stdout.write('Ephemeral QR network probe disabled; set MARKS_EPHEMERAL_QR_PROBE=enabled explicitly.\n');
  process.exit(78);
}
const asar = path.resolve(process.argv[2] || '');
if (!asar.includes('/linux-unpacked/resources/app.asar')) process.exit(70);
const packaged = createRequire(path.join(asar, 'out', 'main', 'index.js'));
(async () => {
 const dir = await fs.mkdtemp(path.join(tmpdir(), 'marks-qr-ephemeral-'));
 let socket;
 let status = 'init';
 let qrCount = 0;
 const safeCode = err => {
   const code = err?.output?.statusCode;
   return Number.isInteger(code) && code >= 100 && code <= 599 ? code : null;
 };
 const timer = setTimeout(() => {status = 'timeout'; finish();}, 19000);
 let finished = false;
 async function finish() {
  if(finished) return;
  finished=true;
  const exitCode = status === 'qr' ? 0 : 1;
  clearTimeout(timer);
  process.stdout.write(JSON.stringify({probe:'ephemeral-whatsapp',state:status,qrSeen:qrCount>0,disconnectStatusCode:statusCode,proxyConfigured:Boolean(process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.ALL_PROXY)})+'\n');
  try { socket?.ws?.socket?.terminate?.(); } catch {}
  try { await fs.rm(dir,{recursive:true,force:true}); } catch {}
  process.exit(exitCode);
 }
 let statusCode = null;
 try {
  const baileys = packaged('@whiskeysockets/baileys');
  const auth = await baileys.useMultiFileAuthState(dir);
  // This brand new ephemeral directory cannot contain any existing account.
  if(auth.state.creds.registered) throw new Error('Unexpected registered ephemeral session');
  const silent={level:'silent', child(){return this},trace(){},debug(){},info(){},warn(){},error(){},fatal(){}};
  socket=baileys.default({auth:auth.state,logger:silent,printQRInTerminal:false,connectTimeoutMs:10000});
  status='connecting';
  socket.ev.on('connection.update', update => {
    if(finished) return;
    if(update.qr){qrCount++;status='qr';void finish();}
    else if(update.connection==='open'){status='connected-unexpected';void finish();}
    else if(update.connection==='close'){status='closed';statusCode=safeCode(update.lastDisconnect?.error);void finish();}
  });
 } catch(err) {
  status='initialization-failed';
  statusCode=safeCode(err);
  void finish();
 }
})().catch(()=>{process.stdout.write('{"probe":"failed-to-run"}\n');process.exit(2)});
