// Production renderer and real Chromium layout/input; synthetic data only.
// Chat Marks CLIProxyAPI management (Modules > CLIProxyAPI): installed and latest versions with a
// local-build warning, the confirmed Update, the write-only management password, and the masked
// API keys with Create and Revoke. No service, password, key or installer is real.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'cliproxy-module'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 // The same language on every runner, whatever the system language is.
 try{localStorage.setItem('cos.ui.language','en');}catch{}
 const old=window.api,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 const module={id:'cli-proxy-api',name:'CLIProxyAPI',description:'API proxy and management console',installed:true,enabled:true,running:true,supported:true,
  consoleAvailable:true,managementUrl:'http://127.0.0.1:18081/management.html',detail:'Managed through the existing systemd service.',
  source:{kind:'github',repository:'router-for-me/CLIProxyAPI',homepage:'https://github.com/router-for-me/CLIProxyAPI',install:'external-guide',update:'upstream-managed'}};
 const versions={installed:'8.0.13-14-g8ef43e4d-dirty',installedOfficial:false,latest:'8.0.36',updateAvailable:true,installable:true};
 const keys=[{id:'0123456789abcdef',last4:'Q7xk',chat:false}];
 const status={versions,hasManagementKey:false,managementKeyValid:null,keys:null,keysError:'management_key_missing',install:null,configRepair:false};
 window.saveBlocked=true;
 window.sent={passwords:[],installs:[],revoked:[],confirms:[]};
 window.confirmAnswer=true;
 window.confirm=question=>{window.sent.confirms.push(question);return window.confirmAnswer;};
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:'dark'};return r;},
  modulesStatus:()=>ok([module]),
  apiChatStatus:()=>ok({endpoint:'http://127.0.0.1:18081/v1',model:null,effort:null,favorites:[],recents:[],hasKey:false,detected:true,keyRequired:false}),
  apiChatModels:()=>ok({models:[],total:0}),
  cliProxyStatus:()=>ok(status),
  cliProxySetManagementKey:key=>{window.sent.passwords.push(key.length);Object.assign(status,{hasManagementKey:true,managementKeyValid:true,keys:keys.slice()});delete status.keysError;return ok(status);},
  cliProxyRepairConfig:()=>{window.sent.repairs=(window.sent.repairs||0)+1;window.saveBlocked=false;status.configRepair=false;return ok(status);},
  cliProxyCreateKey:()=>{if(window.saveBlocked){status.configRepair=true;return Promise.resolve({ok:false,error:'management_save_failed'});}for(const key of keys)key.chat=false;keys.push({id:'fedcba9876543210',last4:'m4Rk',chat:true});status.keys=keys.slice();return ok(status);},
  cliProxyRevokeKey:id=>{window.sent.revoked.push(id);keys.splice(keys.findIndex(key=>key.id===id),1);status.keys=keys.slice();return ok(status);},
  cliProxyInstall:(mode,version)=>{window.sent.installs.push([mode,version]);window.progress?.({mode,phase:'done',version});return ok(status);},
  onCliProxyProgress:listener=>{window.progress=listener;return()=>undefined;},
  markWhatsNewSeen:()=>ok(true)
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'cliproxy-module-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:900,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const text=id=>js(`document.getElementById(${JSON.stringify(id)}).textContent`);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(180);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!document.querySelector('[data-tab="modules"]')`);
  win.show(); win.focus(); win.webContents.focus(); await pause(100);
  await js(`document.querySelector('[data-tab="modules"]').click()`);
  await until(`document.getElementById('cliProxyInstalledVersion')?.textContent==='Installed version: 8.0.13-14-g8ef43e4d-dirty'`);
  assert.equal(await text('cliProxyLatestVersion'),'Latest release: 8.0.36');
  assert.equal(await js(`document.getElementById('cliProxyUpdateBadge').hidden`),false,'Shows that an update exists');
  assert.equal(await js(`document.getElementById('cliProxyLocalBuild').hidden`),false,'Warns about the local build');
  assert.equal(await text('moduleCliUpdate'),'Update to 8.0.36');
  assert.equal(await js(`document.getElementById('moduleCliUpdate').disabled`),false);
  assert.equal(await js(`document.getElementById('moduleCliInstall').disabled`),true,'Install stays off while installed');
  assert.equal(await text('cliProxyManagementKeyState'),'No password saved');
  assert.equal(await text('cliProxyMessage'),'Save the management password to manage API keys.');
  assert.equal(await js(`document.getElementById('cliProxyCreateKey').disabled`),true,'No key management without the password');

  // The password only goes in; the field empties and the list appears once the service accepted it.
  await js(`(()=>{const field=document.getElementById('cliProxyManagementKey');field.value='synthetic-management-password';document.getElementById('cliProxySaveManagementKey').click();})()`);
  await until(`document.getElementById('cliProxyManagementKeyState').textContent==='A password is saved'`);
  assert.equal(await js(`document.getElementById('cliProxyManagementKey').value`),'');
  assert.deepEqual(await js(`window.sent.passwords`),[29]);
  assert.deepEqual(await js(`[...document.querySelectorAll('#cliProxyKeys .cliproxy-key')].map(n=>n.textContent)`),['•••• Q7xk']);

  // A service that cannot save its config: the failure is explained and the confirmed repair offered.
  assert.equal(await js(`document.getElementById('cliProxyRepair').hidden`),true);
  await js(`document.getElementById('cliProxyCreateKey').click()`);
  await until(`!document.getElementById('cliProxyRepair').hidden`);
  assert.equal(await text('cliProxyMessage'),'CLIProxyAPI could not save its configuration. Check that the service can write its config file.');
  await js(`document.getElementById('cliProxyRepair').scrollIntoView({block:'center'})`);
  await capture('cliproxy-repair.png');
  await js(`window.confirmAnswer=false;document.getElementById('cliProxyRepairConfig').click()`);
  await pause(100);
  assert.equal(await js(`window.sent.repairs||0`),0,'A declined confirmation does not repair');
  await js(`window.confirmAnswer=true;document.getElementById('cliProxyRepairConfig').click()`);
  await until(`document.getElementById('cliProxyRepair').hidden`);
  assert.equal(await text('cliProxyMessage'),'CLIProxyAPI can now save its settings.');
  assert.match((await js(`window.sent.confirms`)).at(-1),/^Allow CLIProxyAPI to save its settings\? .*The service unit itself is not changed\.$/);
  await js(`document.getElementById('cliProxyCreateKey').click()`);
  await until(`document.querySelectorAll('#cliProxyKeys .cliproxy-key').length===2`);
  assert.equal(await text('cliProxyMessage'),'API key created and saved for Chat with CLIProxy.');
  assert.match(await js(`document.querySelectorAll('#cliProxyKeys li')[1].textContent`),/•••• m4Rk.*Used by Chat with CLIProxy/);
  await js(`document.querySelector('.modules-service #cliProxyManage').scrollIntoView({block:'center'})`);
  await capture('cliproxy-module.png');

  // Revoke asks first; a declined question changes nothing.
  await js(`window.confirmAnswer=false;document.querySelector('#cliProxyKeys button[data-key-id="0123456789abcdef"]').click()`);
  await pause(100);
  assert.deepEqual(await js(`window.sent.revoked`),[]);
  await js(`window.confirmAnswer=true;document.querySelector('#cliProxyKeys button[data-key-id="0123456789abcdef"]').click()`);
  await until(`document.querySelectorAll('#cliProxyKeys .cliproxy-key').length===1`);
  assert.deepEqual(await js(`window.sent.revoked`),['0123456789abcdef']);
  assert.match((await js(`window.sent.confirms`)).at(-1),/^Revoke the key ending in Q7xk\?/);

  // Update needs the confirmation, which names the version and the local build it replaces.
  await js(`window.confirmAnswer=false;document.getElementById('moduleCliUpdate').click()`);
  await pause(100);
  assert.deepEqual(await js(`window.sent.installs`),[]);
  const question=(await js(`window.sent.confirms`)).at(-1);
  assert.match(question,/^Update CLIProxyAPI to 8\.0\.36\?/);
  assert.match(question,/The installed program \(8\.0\.13-14-g8ef43e4d-dirty\) is a local build; updating replaces it\./);
  await js(`window.confirmAnswer=true;document.getElementById('moduleCliUpdate').click()`);
  await until(`window.sent.installs.length===1`);
  assert.deepEqual(await js(`window.sent.installs`),[['update','8.0.36']]);
  await until(`document.getElementById('cliProxyProgress').textContent==='Installed 8.0.36.'`);
  assert.deepEqual(errors,[]);
  console.log('PASS: CLIProxyAPI module shows versions, confirms the update, saves a write-only management password and manages masked API keys');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
