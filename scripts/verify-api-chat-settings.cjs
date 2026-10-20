// Production renderer and real Chromium layout/input; synthetic data only.
// Chat Marks API chat settings (Modules > CLIProxyAPI): the key field only writes, the page shows
// whether a key is stored, models come from the endpoint without image models, and Test reports.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'api-chat-settings'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 const old=window.api,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 const status={endpoint:'http://127.0.0.1:18081/v1',model:'claude-sonnet-5-5',effort:null,favorites:['claude-opus-5-5'],recents:['claude-sonnet-5-5'],hasKey:false,detected:true,keyRequired:true};
 const row=(id,ownedBy,extra={})=>({id,ownedBy,modality:'chat',favorite:status.favorites.includes(id),recent:status.recents.includes(id),availability:null,...extra});
 window.sentKeys=[];
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'pt-BR',theme:'dark'};return r;},
  apiChatStatus:()=>ok(status),
  apiChatSetKey:key=>{window.sentKeys.push(key.length);status.hasKey=key.length>0;status.keyRequired=!status.hasKey;return ok(status);},
  apiChatToggleFavorite:id=>{status.favorites=status.favorites.includes(id)?status.favorites.filter(x=>x!==id):[id,...status.favorites];return ok(status);},
  apiChatSetSettings:patch=>{Object.assign(status,patch);return ok(status);},
  apiChatModels:()=>ok({models:[row('claude-opus-5-5','anthropic'),row('claude-sonnet-5-5','anthropic',{availability:window.tested?{ok:true,at:1}:null}),row('gpt-6-sol','openai')],total:3}),
  apiChatTest:()=>{window.tested=true;return ok({model:status.model});}
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'api-chat-settings-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(180);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!document.querySelector('[data-tab="modules"]')`);
  win.show(); win.focus(); win.webContents.focus(); await pause(100);
  await js(`document.querySelector('[data-tab="modules"]').click()`);
  await until(`document.querySelectorAll('#apiChatModel option').length===3`);
  assert.equal(await js(`document.getElementById('apiChatKeyState').textContent`),'Nenhuma chave salva');
  assert.equal(await js(`document.getElementById('apiChatKeyNeeded').hidden`),false,'Asks for the key the proxy required');
  assert.match(await js(`document.getElementById('apiChatDetection').textContent`),/^Encontrado em http:\/\/127\.0\.0\.1:18081\/v1 · 3 modelos de chat$/);
  assert.deepEqual(await js(`[...document.querySelectorAll('#apiChatModel optgroup')].map(g=>g.label)`),['Favoritos','Recentes','openai']);
  assert.equal(await js(`document.getElementById('apiChatModel').value`),'claude-sonnet-5-5');
  await js(`(()=>{const k=document.getElementById('apiChatKey');k.value='sk-synthetic-key';document.getElementById('apiChatSaveKey').click();})()`);
  await until(`document.getElementById('apiChatKeyState').textContent==='Há uma chave salva'`);
  assert.equal(await js(`document.getElementById('apiChatKey').value`),'','The key field empties after saving');
  await js(`document.getElementById('apiChatTest').click()`);
  await until(`document.getElementById('apiChatResult').textContent==='claude-sonnet-5-5 respondeu.'`);
  await until(`document.querySelector('#apiChatModel option[value="claude-sonnet-5-5"]').textContent==='claude-sonnet-5-5 ✓'`);
  assert.equal(await js(`document.getElementById('apiChatKeyNeeded').hidden`),true);
  await js(`document.getElementById('apiChatSettings').scrollIntoView({block:'center'})`);
  await capture('settings.png');
  assert.deepEqual(errors,[]);
  console.log('PASS: API chat settings save a write-only key, list chat models and report a test answer');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
