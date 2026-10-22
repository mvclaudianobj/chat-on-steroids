// Real Chromium UI check with a disposable fixture. No microphone or CLIProxy is contacted.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp/jarvis-ui'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
  try { localStorage.setItem('cos.ui.language','en'); } catch {}
  const original=window.api;
  const methods={
    getState:async()=>{const r=await original.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:'dark'};return r;},
    dictationSupported:true,
    startDictation:async()=>({ok:true,data:{status:'starting'}}),
    stopDictation:async()=>({ok:true}),
    onDictationEvent:()=>()=>{}
  };
  window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:original[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false,root:path.join(root,'src/renderer'),cacheDir:path.join(output,'vite'),logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'jarvis-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/jarvis-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{
        if(req.url!=='/jarvis-fixture.js')return next();
        res.setHeader('Content-Type','text/javascript');
        res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);
      });}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1240,height:850,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',event=>{if(event.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(event.message))errors.push(event.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(50);}throw new Error('Timed out: '+expression);};
  const shot=async name=>{await pause(200);fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`!!document.querySelector('[data-tab="jarvis"]')`);
  win.show();win.focus();win.webContents.focus();
  await js(`document.querySelector('[data-tab="jarvis"]').click()`);
  await until(`document.querySelector('[data-panel="jarvis"]').classList.contains('is-active')`);
  assert.equal(await js(`document.querySelector('[data-panel="general"]').classList.contains('is-active')`),false);
  assert.equal(await js(`document.getElementById('jarvisEnabled').checked`),false);
  await shot('jarvis-settings-before.png');
  await js(`(()=>{
    const changed=(id,value)=>{const input=document.getElementById(id);input.checked=value;input.dispatchEvent(new Event('change',{bubbles:true}));};
    changed('jarvisEnabled',true);
    const key=document.getElementById('jarvisKey');key.value='F9';key.dispatchEvent(new Event('change',{bubbles:true}));
    changed('jarvisConsent',true);
    changed('jarvisTts',true);
  })()`);
  assert.equal(await js(`document.getElementById('jarvisKey').value`),'F9');
  assert.equal(await js(`document.getElementById('jarvisTalk').hidden`),false);
  assert.equal(await js(`document.getElementById('jarvisTalk').getAttribute('aria-pressed')`),'false');
  await shot('jarvis-settings-configured.png');
  assert.deepEqual(errors,[]);
  console.log('PASS: Jarvis dedicated settings page, opt-in, hold key and inactive capture rendered in Chromium with synthetic data.');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{
  fs.mkdirSync(output,{recursive:true});
  if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'jarvis-ui-error.png'),(await win.webContents.capturePage()).toPNG());
  console.error(error);await server?.close();app.exit(1);
});
