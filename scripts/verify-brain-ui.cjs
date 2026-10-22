// Real Chromium Brain Settings exercise with synthetic memories and isolated userData.
// No installed Chat Marks profile, provider, or other application's database is opened.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp/brain-ui'));
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
  const settings={chatgptTools:false,apiChatTools:false,askBeforeSaving:true};
  let memories=[{id:'00000000-0000-4000-8000-000000000001',content:'Synthetic memory: the project mascot is Marks.',title:'Project mascot',tags:['project'],type:'semantic',mode:'long_term',importance:0.5,scope:'global',provenance:{source:'user'},createdAt:1,updatedAt:1,contentHash:'f'.repeat(64)}];
  const pending=[{id:'00000000-0000-4000-8000-000000000002',chat:'synthetic-chat',content:'Synthetic approval awaiting review'}];
  const methods={
    getState:async()=>{const r=await original.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:'dark'};return r;},
    brain:(action,payload={})=>{
      if(action==='status')return ok({available:true,count:memories.length,bytes:32768});
      if(action==='doctor')return ok({available:true,quickCheck:true,fts:true});
      if(action==='sources')return ok([{id:'local',type:'sqlite',enabled:true}]);
      if(action==='settings.get')return ok(settings);
      if(action==='settings.set'){Object.assign(settings,payload);return ok(settings);}
      if(action==='memories.list')return ok(memories);
      if(action==='memories.search'||action==='recall')return ok(memories.filter(m=>m.content.toLowerCase().includes((payload.query||'').toLowerCase())));
      if(action==='memories.save'){
        const item={...memories[0],...payload,id:'00000000-0000-4000-8000-000000000003',title:payload.title||'',createdAt:2,updatedAt:2};memories.push(item);return ok(item);
      }
      if(action==='memories.update'){
        const index=memories.findIndex(m=>m.id===payload.id);memories[index]={...memories[index],...payload};return ok(memories[index]);
      }
      if(action==='memories.delete'){memories=memories.filter(m=>m.id!==payload.id);return ok(true);}
      if(action==='pending.list')return ok(pending);
      if(action==='pending.decide'){const i=pending.findIndex(p=>p.id===payload.id);if(i>=0)pending.splice(i,1);return ok(true);}
      if(action==='memories.export')return ok(true);
      return Promise.resolve({ok:false,error:'Unexpected fixture action: '+action});
    }
  };
  window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:original[key]});
})();`;

app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'brain-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/brain-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((request,response,next)=>{
        if(request.url!=='/brain-fixture.js')return next();
        response.setHeader('Content-Type','text/javascript');
        response.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);
      });}}] });
  await server.listen();
  win = new BrowserWindow({ show:false, width:1240, height:850, webPreferences:{ sandbox:true, offscreen:true, backgroundThrottling:false } });
  const errors=[];
  win.webContents.on('console-message', event => { if(event.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(event.message))errors.push(event.message); });
  const js=expression=>win.webContents.executeJavaScript(expression);
  const until=async expression=>{for(const end=Date.now()+15000;Date.now()<end;){if(await js(expression))return;await pause(60);}throw new Error('Timeout: '+expression);};
  const shot=async name=>{fs.mkdirSync(output,{recursive:true});await pause(180);fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until("!!document.querySelector('[data-tab=brain]')");
  win.show();win.focus();win.webContents.focus();
  await js("document.querySelector('[data-tab=brain]').click()");
  await until("document.getElementById('brainCount').textContent.includes('1')");
  assert.equal(await js("document.querySelector('[data-panel=brain]').classList.contains('is-active')"),true);
  assert.equal(await js("document.querySelectorAll('.brain-memory-row').length"),1);
  await js("document.getElementById('brainMemoryTitle').value='New information';document.getElementById('brainMemoryContent').value='Synthetic test of local Brain memory';document.getElementById('brainEditor').requestSubmit()");
  await until("document.querySelectorAll('.brain-memory-row').length===2");
  await js("document.getElementById('brainChatgptTools').click()");
  assert.equal(await js("document.getElementById('brainChatgptTools').checked"),true);
  await js("document.getElementById('brainDoctorRun').click()");
  await until("document.getElementById('brainDoctor').textContent.includes('FTS5: OK')");
  await shot('brain-dark.png');
  await js("document.getElementById('brainPendingRefresh').click()");
  await until("document.querySelectorAll('#brainPending .brain-pending-row').length===1 && !document.querySelector('.brain-approval-banner').hidden");
  await js("document.querySelector('.brain-approval-banner .brain-pending-row button').click()");
  await until("!document.querySelector('#brainPending .brain-pending-row') && document.querySelector('.brain-approval-banner').hidden");
  await js("window.confirm=()=>true;document.getElementById('brainDelete').click()");
  await until("document.querySelectorAll('.brain-memory-row').length===1");
  assert.deepEqual(errors,[]);
  console.log('PASS: Brain Settings renders, searches, saves and deletes synthetic memories, diagnoses FTS5, toggles model tools and approves a save.');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{
  fs.mkdirSync(output,{recursive:true});
  if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'brain-error.png'),(await win.webContents.capturePage()).toPNG());
  console.error(error);await server?.close();app.exit(1);
});
