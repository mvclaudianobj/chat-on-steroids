// Browser rendering and interaction with synthetic VM data. Never invokes a hypervisor.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp/vms-ui'));
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
  const labs=[{name:'qa-lab',box:'bento/ubuntu-24.04',memory:2048,cpus:2,valid:true}];
  const jobs=[];
  const doctor={ready:false,checks:[{id:'vagrant',available:false,reason:'not-found'},{id:'virtualbox',available:true},{id:'ansible',available:false,reason:'not-found'}]};
  const methods={
    getState:async()=>{const r=await original.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:'dark'};return r;},
    vmsView:()=>ok({labs,doctor,jobs}),
    vmsInit:(name,box,memory,cpus)=>{labs.push({name,box,memory,cpus,valid:true});return ok({labs,doctor,jobs});},
    vmsRun:(name,action,confirmation,dryRun)=>{if(!dryRun)return Promise.resolve({ok:false,error:'Real VM execution forbidden in fixture'});if(action==='destroy'&&confirmation!==name)return Promise.resolve({ok:false,error:'Confirmation mismatch'});const job={name,action,running:false,log:['DRY RUN: vagrant '+action],exitCode:0};jobs.push(job);return ok(job);},
    vmsCancel:()=>ok(true),onVmsEvent:()=>()=>{}
  };
  window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:original[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false,root:path.join(root,'src/renderer'),cacheDir:path.join(output,'vite'),logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'vms-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/vms-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/vms-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:950,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors = [];
  win.webContents.on('console-message',event=>{if(event.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(event.message))errors.push(event.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const end=Date.now()+15000;Date.now()<end;){if(await js(expression))return;await pause(70);}throw Error('Timeout '+expression);};
  const shot=async name=>{fs.mkdirSync(output,{recursive:true});await pause(300);fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until("!!document.querySelector('[data-tab=modules]')");
  win.show();win.focus();win.webContents.focus();
  await js("document.querySelector('[data-tab=modules]').click()");
  await until("document.querySelector('.vms-lab h3')?.textContent==='qa-lab'");
  await js("document.querySelector('.vms-module').scrollIntoView({block:'center'})");
  await shot('vms-overview.png');
  assert.equal(await js("document.querySelector('.vms-doctor').textContent.includes('VirtualBox: Available')"),true);
  await js("document.querySelector('.vms-module label input[type=checkbox]').click()");
  await js("Array.from(document.querySelectorAll('.vms-lab button')).find(b=>b.textContent==='Start VM').click()");
  await until("document.querySelector('.vms-log')?.textContent.includes('DRY RUN: vagrant up')");
  await shot('vms-dry-run.png');
  assert.deepEqual(errors,[]);
  console.log('PASS: VMs module renders host doctor, profile and simulated launch in Chromium.');
  win.destroy();await server.close();app.exit(0);
}).catch(async err=>{
  fs.mkdirSync(output,{recursive:true});
  if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());
  console.error(err);await server?.close();app.exit(1);
});
