/**
 * Native Chromium + production preload -> IPC -> real approval-wait owner.
 * All cards, sessions, credentials and responses are synthetic; no ChatGPT page
 * or production Chat Marks process is opened.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE ./node_modules/electron/dist/electron --no-sandbox \
 *   scripts/verify-host-approval-electron.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-marks-host-card-'));
for (const [env, relative] of Object.entries({ HOME:'home', XDG_CONFIG_HOME:'config', XDG_CACHE_HOME:'cache', XDG_DATA_HOME:'data' })) {
  process.env[env] = path.join(temp, relative);
  fs.mkdirSync(process.env[env], { recursive:true });
}
app.setPath('userData', path.join(temp, 'userData'));
app.disableHardwareAcceleration();

// Bundle the real authority; replace only the unrelated outbound notification
// channel, to ensure that this synthetic gate never notifies the user.
const bundle = path.join(temp, 'approval-owner.cjs');
const bundleOptions = {
  entryPoints:[path.join(root, 'src/main/approval-wait.ts')], outfile:bundle,
  bundle:true, platform:'node', format:'cjs', packages:'external', logLevel:'silent',
  plugins:[{name:'isolated-notifications',setup(build){
    build.onResolve({filter:/notification-center\.js$/}, () => ({ path:'synthetic-notifications', namespace:'synthetic' }));
    build.onLoad({filter:/.*/,namespace:'synthetic'}, () => ({ contents:'export async function queueOutboundNotice() {}', loader:'js' }));
  }}]
};
let approval;
const rows = [];
const notices = [];
const deps = {
  record:async (sessionId,progressId,text,anchor) => { rows.push({sessionId,progressId,text}); return anchor ?? {seq:1,time:1}; },
  notify:sessionId => { notices.push(sessionId); },
  log:() => undefined
};
const sessionId = 'synthetic-session';
const conversationId = 'synthetic-chat';
const words = ['Allow ChatGPT to use Chat Marks Core?', 'Run one synthetic command.'];
const card = id => ({id,lines:words,allow:true});
let window = null;

async function run() {
  await esbuild.build(bundleOptions);
  approval = require(bundle);
  await app.whenReady();
  // The real preload exposes only fixed typed IPC methods. The renderer cannot
  // invent an 'always' choice or invoke arbitrary main-process operations.
  ipcMain.handle('sessions:approvalCard', (_event,payload) => {
    assert.equal(payload.id,sessionId);
    return {ok:true,data:approval.approvalCardView(conversationId)};
  });
  ipcMain.handle('sessions:answerApproval', (_event,payload) => {
    assert.equal(payload.id,sessionId);
    return {ok:true,data:approval.requestApprovalAnswer(conversationId,payload.cardId,payload.choice)};
  });
  window = new BrowserWindow({show:false, width:800, height:500, webPreferences:{
    preload:path.join(root,'out/preload/index.js'), sandbox:true,
    contextIsolation:true, nodeIntegration:false, backgroundThrottling:false
  }});
  const html = '<!doctype html><html lang="pt-BR"><body><main><h1>Permissão sintética</h1><button id="send">Permitir uma vez</button></main></body></html>';
  await window.loadURL('data:text/html;charset=UTF-8,' + encodeURIComponent(html));
  const renderer = code => window.webContents.executeJavaScript(code);
  assert.equal(await renderer('typeof window.api.approvalCard'), 'function');
  assert.equal(await renderer('typeof window.api.answerApproval'), 'function');

  const now = Date.now();
  await approval.noteApprovalCard(conversationId,true,sessionId,deps,now,card('host-card-first'));
  const first = await renderer(`window.api.approvalCard(${JSON.stringify(sessionId)})`);
  assert.equal(first.data.id,'host-card-first');
  assert.equal(first.data.allow,true);
  const sent = await renderer(`window.api.answerApproval(${JSON.stringify(sessionId)},'host-card-first','allow')`);
  assert.equal(sent.data.ok,true);
  const queued = approval.approvalAnswerFor(conversationId);
  assert.deepEqual({cardId:queued.cardId,choice:queued.choice},{cardId:'host-card-first',choice:'allow'});
  assert.equal(approval.settleApprovalAnswer(conversationId,queued.token,'dismissed'),true);
  await approval.noteApprovalCard(conversationId,false,sessionId,deps,now+200);
  await approval.noteApprovalCard(conversationId,true,sessionId,deps,now+700,card('host-card-second'));
  const second = await renderer(`window.api.approvalCard(${JSON.stringify(sessionId)})`);
  assert.equal(second.data.id,'host-card-second');
  assert.equal(second.data.answer,null);
  const waiting = rows.filter(row => row.text.includes('waiting for you'));
  assert.equal(new Set(waiting.map(row=>row.progressId)).size,2);
  const stale = await renderer(`window.api.answerApproval(${JSON.stringify(sessionId)},'host-card-first','allow')`);
  assert.equal(stale.data.error,'card_changed');
  assert.equal(approval.settleApprovalAnswer(conversationId,queued.token,'dismissed'),false);
  const unsupported = await renderer(`window.api.answerApproval(${JSON.stringify(sessionId)},'host-card-second','always')`);
  assert.equal(unsupported.data.error,'bad_choice');
  assert.equal(approval.approvalAnswerFor(conversationId),null);
  console.log('PASS: native Electron preload + synthetic main approval IPC; two distinct host episodes, old-token replay blocked, no always grant');
}

run().then(() => {
  window?.destroy();
  fs.rmSync(temp,{recursive:true,force:true});
  app.exit(0);
}).catch(error => {
  console.error('FAIL: synthetic Electron approval IPC:', error);
  window?.destroy();
  fs.rmSync(temp,{recursive:true,force:true});
  app.exit(1);
});
