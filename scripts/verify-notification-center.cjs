// Real Electron/Chromium renderer with synthetic notification settings and write-only credentials.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const QRCode = require('qrcode');
let qrFixtureData = '';
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'notification-center'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
  const old=window.api,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
  const events=['turn-completed','turn-failed','approval-pending','module-update','app-release'];
  const channels=['smtp','telegram','whatsapp-web','whatsapp-cloud','whatsapp-evolution'];
  const base=()=>({enabled:false,events:Object.fromEntries(events.map(e=>[e,false])),destinations:[],titleTemplate:'{title}',bodyTemplate:'{project} — {event}',includeExcerpt:false,config:{}});
  let settings={channels:Object.fromEntries(channels.map(c=>[c,base()])),throttleMinutes:1,batchWindowSeconds:10};
  const credentials=Object.fromEntries(channels.map(c=>[c,false]));
  window.notifyFixture={testCalls:[],savedKeys:[],exportCalls:0,importCalls:0,vaultCreated:false,latest:()=>structuredClone(settings)};
  const methods={
    markWhatsNewSeen:()=>ok(null),
    getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:'dark'};return r;},
    notificationWhatsAppStart:()=>ok({state:'qr',qr:'__SYNTHETIC_QR_IMAGE__'}),
    notificationWhatsAppStatus:()=>ok({state:'connected'}),
    notificationWhatsAppDisconnect:()=>ok({state:'disconnected'}),
    notificationTelegramPairStart:()=>ok({url:'https://t.me/example_bot?start=synthetic',expires:Date.now()+60000,qr:'__SYNTHETIC_QR_IMAGE__'}),
    notificationTelegramPairCheck:()=>ok({state:'paired',chatId:'90001'}),
    notificationTelegramPairCancel:()=>ok(true),
    notificationCenterGet:()=>ok({settings,credentials}),
    notificationCenterSave:next=>{settings=structuredClone(next);return ok({settings,credentials});},
    notificationCenterSetCredential:(channel,key,masterPassword)=>{window.notifyFixture.savedKeys.push({channel,length:key.length,masterLength:masterPassword.length});credentials[channel]=key.length>0;return ok({settings,credentials});},
    notificationCenterTest:channel=>{window.notifyFixture.testCalls.push(channel);return ok({delivered:settings.channels[channel].destinations.length});},
    notificationCenterExport:()=>{window.notifyFixture.exportCalls++;return ok(true);},
    notificationCenterImport:()=>{
      window.notifyFixture.importCalls++;
      settings={...settings,channels:{...settings.channels,telegram:{...settings.channels.telegram,destinations:['90001']}}};
      for(const channel of channels) credentials[channel]=false;
      return ok({imported:true});
    },
    vault:action=>action==='status'?ok({created:window.notifyFixture.vaultCreated,ready:window.notifyFixture.vaultCreated,count:0}):ok(null)
  };
  window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  qrFixtureData = await QRCode.toDataURL('https://t.me/synthetic_bot?start=local-test-code');
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'notification-center-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/notification-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/notification-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture.replaceAll('__SYNTHETIC_QR_IMAGE__', qrFixtureData));});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1300,height:900,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(50);}throw new Error('Timed out: '+expression);};
  const capture=async name=>{await pause(250);fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!document.querySelector('[data-tab="notifications"]')`);
  win.show(); win.focus(); win.webContents.focus();
  await js(`document.querySelector('[data-tab="notifications"]').click()`);
  await until(`!!document.getElementById('notificationTitle-telegram')`);
  await until(`document.querySelector('[data-panel="notifications"]').classList.contains('is-active')`);
  assert.equal(await js(`document.querySelector('[data-panel="general"]').classList.contains('is-active')`),false);
  assert.equal(await js(`document.querySelector('#tabs [data-tab="notifications"]').classList.contains('is-sel')`),true);
  assert.equal(await js(`document.getElementById('notificationsTitle').textContent.trim().length>0`),true);
  await capture('notification-center-page.png');
  await js(`document.getElementById('notificationCenterSection').scrollIntoView({block:'start'})`);
  await capture('notification-center-overview.png');
  await js(`(()=>{
    const enabled=document.getElementById('notificationEnabled-telegram');enabled.checked=true;enabled.dispatchEvent(new Event('change',{bubbles:true}));
    const completed=document.getElementById('notification-telegram-turn-completed');completed.checked=true;completed.dispatchEvent(new Event('change',{bubbles:true}));
    const recipients=document.getElementById('notificationDestinations-telegram');recipients.value='10001\\n10002';recipients.dispatchEvent(new Event('input',{bubbles:true}));
    document.getElementById('notificationCredential-telegram').value='synthetic-token-not-real';
    document.getElementById('notificationMasterPassword-telegram').value='synthetic-master-passphrase';
    document.querySelector('#notification-telegram-turn-completed').scrollIntoView({block:'center'});
  })()`);
  assert.equal(await js(`!!document.getElementById('notificationStore-telegram')`),true);
  // Saving a credential must not create a Vault implicitly.
  await js(`document.getElementById('notificationStore-telegram').click()`);
  await until(`document.querySelector('#notificationTitle-telegram').closest('section').querySelector('.notification-vault-notice').hidden===false`);
  assert.deepEqual(await js(`window.notifyFixture.savedKeys`),[]);
  await js(`document.querySelector('#notificationTitle-telegram').closest('section').querySelector('.notification-vault-notice button').click()`);
  await until(`document.querySelector('[data-panel="general"]').classList.contains('is-active')`);
  await js(`window.notifyFixture.vaultCreated=true;document.querySelector('[data-tab="notifications"]').click()`);
  await until(`document.querySelector('[data-panel="notifications"]').classList.contains('is-active')`);
  await js(`document.getElementById('notificationCredential-telegram').value='synthetic-token-not-real';document.getElementById('notificationMasterPassword-telegram').value='synthetic-master-passphrase'`);
  await js(`document.getElementById('notificationStore-telegram').click()`);
  await until(`document.getElementById('notificationCredential-telegram').value===''`);
  await until(`window.notifyFixture.savedKeys.length===1`);
  assert.deepEqual(await js(`window.notifyFixture.savedKeys`),[{channel:'telegram',length:24,masterLength:27}]);
  assert.equal(await js(`document.getElementById('notificationMasterPassword-telegram').value`),'');
  await js(`document.getElementById('notificationTest-telegram').click()`);
  await until(`window.notifyFixture.testCalls.length===1`);
  assert.deepEqual(await js(`window.notifyFixture.testCalls`),['telegram']);
  assert.deepEqual(await js(`window.notifyFixture.latest().channels.telegram.destinations`),['10001','10002']);
  assert.equal(await js(`window.notifyFixture.latest().channels.telegram.events['turn-completed']`),true);
  assert.equal(await js(`document.getElementById('notificationCredential-telegram').value`),'');
  await js(`document.getElementById('notificationExport').click()`);
  await until(`window.notifyFixture.exportCalls===1`);
  await js(`document.getElementById('notificationImport').click()`);
  await until(`window.notifyFixture.importCalls===1`);
  await until(`document.getElementById('notificationDestinations-telegram').value==='90001'`);
  // Locale may be restored from saved app preferences; don't require an English sentence.
  assert.equal(await js(`document.getElementById('notificationCenterStatus').textContent.trim().length>15`),true);
  assert.equal(await js(`!document.getElementById('notificationCenterStatus').classList.contains('is-error')`),true);
  assert.equal(await js(`document.getElementById('notificationCredential-telegram').value`),'');
  assert.equal(await js(`document.getElementById('notificationMasterPassword-telegram').value`),'');
  await js(`document.getElementById('notificationTitle-telegram').scrollIntoView({block:'center'})`);
  await capture('notification-center-telegram.png');
  await js(`document.getElementById('notificationPair-telegram').click()`);
  await until(`document.querySelector('#notificationTitle-telegram + *') === null || !!document.querySelector('.notification-channel-pairing img[src^="data:image/png"]')`);
  await js(`document.getElementById('notificationPair-telegram').scrollIntoView({block:'center'})`);
  await capture('notification-telegram-qr-synthetic.png');
  await js(`document.getElementById('notificationDisconnect-telegram').click()`);
  await js(`document.getElementById('notificationPair-whatsapp-web').click()`);
  await until(`document.querySelector('#notificationTitle-whatsapp-web').closest('section').querySelector('.notification-channel-pairing img').src.startsWith('data:image/png')`);
  await js(`document.getElementById('notificationPair-whatsapp-web').scrollIntoView({block:'center'})`);
  await capture('notification-whatsapp-qr-synthetic.png');
  await js(`document.getElementById('notificationTitle-whatsapp-cloud').scrollIntoView({block:'center'})`);
  await capture('notification-center-whatsapp.png');
  assert.deepEqual(errors,[]);
  console.log('PASS: Notifications UI saved synthetic settings, write-only credentials, per-event rules and test delivery');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{
  fs.mkdirSync(output,{recursive:true});
  if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());
  console.error(error);await server?.close();app.exit(1);
});
