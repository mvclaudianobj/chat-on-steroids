// Real Electron screenshot of the ZeroClaw migration flow; all displayed data synthetic.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp/zeroclaw-migration-ui'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
  try { localStorage.setItem('cos.ui.language','en'); } catch {}
  const original=window.api;
  const ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
  const cli=[{id:'zeroclaw',name:'ZeroClaw',installed:true,enabled:true,running:false,supported:true,version:'0.8.6',detail:'ready',upstream:true}];
  const methods={
    getState:async()=>{const r=await original.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:'dark'};return r;},
    cliStatus:()=>ok(cli), cliSessions:()=>ok([]),
    upstreamZeroClawFacts:()=>ok({configured:true,agents:[{alias:'helper',provider:'openai',memory:'sqlite',enabled:true}],runtime:'native',gateway:'127.0.0.1:42617',dailyLimitUsd:10,monthlyLimitUsd:100}),
    upstreamStatus:()=>ok({module:'zeroclaw',versions:{installed:'0.8.6',unmanaged:null,latest:'0.8.6',updateAvailable:false,latestUnsupported:false,support:'ok',installable:true},install:null}),
    upstreamMarksClawPreview:()=>ok({available:true,configuration:true,sessions:true,devices:true,encryptedCredentials:true,agents:['helper','archive'],riskProfiles:['careful'],runtimeProfiles:['focused'],existingZeroClaw:true,conflicts:['agents.helper'],importable:3,ticket:'00000000-0000-4000-8000-000000000000'}),
    upstreamMarksClawImport:()=>Promise.resolve({ok:false,error:'Synthetic fixture: import disabled'})
  };
  window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:original[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({configFile:false,root:path.join(root,'src/renderer'),cacheDir:path.join(output,'vite'),logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'zeroclaw-migration-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/zeroclaw-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/zeroclaw-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1360,height:1050,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',event=>{if(event.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(event.message))errors.push(event.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const end=Date.now()+18000;Date.now()<end;){if(await js(expression))return;await pause(80);}throw Error('Timeout '+expression);};
  const shot=async name=>{fs.mkdirSync(output,{recursive:true});await pause(500);fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until("!!document.getElementById('sidebarZeroClaw') && !document.getElementById('sidebarZeroClaw').hidden");
  win.show(); win.focus(); win.webContents.focus();
  await js("document.getElementById('sidebarZeroClaw').click()");
  await until("document.querySelector('[data-panel=zeroclaw]') && !document.querySelector('[data-panel=zeroclaw]').hidden");
  await js("document.getElementById('zeroclawMarksPreview').scrollIntoView({block:'center'})");
  await shot('zeroclaw-migration-before.png');
  await js("document.getElementById('zeroclawMarksPreview').click()");
  await until("document.getElementById('zeroclawMarksReport').textContent.includes('Compatible entries to import')");
  assert.equal(await js("document.getElementById('zeroclawMarksImport').hidden"),false);
  assert.equal(await js("document.getElementById('zeroclawMarksReport').textContent.includes('Conflicting profiles (preserved): 1')"),true);
  await shot('zeroclaw-migration-preview.png');
  assert.deepEqual(errors,[]);
  console.log('PASS: ZeroClaw migration preview renders with synthetic, secret-free data in Electron.');
  win.destroy(); await server.close(); app.exit(0);
}).catch(async err=>{
  fs.mkdirSync(output,{recursive:true});
  if(win&&!win.isDestroyed()) fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());
  console.error(err);await server?.close();app.exit(1);
});
