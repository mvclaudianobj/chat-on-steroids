// Real Electron/renderer archive controls against an isolated fake IPC store.
// This does not connect to ChatGPT, use a production profile, or archive external chats.
const { app, BrowserWindow } = require('electron');
const { createServer } = require('vite');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require('./fixtures/app-defaults.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marks-native-archive-'));
app.setPath('userData', path.join(temp, 'profile'));
app.disableHardwareAcceleration();
let server, win;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fixture = `(() => {
  localStorage.setItem('cos.ui.language','en');
  const original = window.api, f = window.composerFixture;
  const now = Date.now(), ok = data => Promise.resolve({ok:true,data:structuredClone(data)});
  const ordinary = f.summary;
  ordinary.title='Standalone chat · retained transcript';
  ordinary.projectId=null;
  ordinary.endedAt=now-3000;
  ordinary.updatedAt=now-3000;
  const worker = {...ordinary,id:'finished-worker',conversationId:'worker-conv',chatIds:['worker-conv'],
    title:'Completed worker — retained',origin:{kind:'worker',fromSessionId:ordinary.id,agentId:'worker-1',task:'Completed task'},
    archivedAt:now-2500,updatedAt:now-2500,events:12,projectId:'project-keep'};
  const second = {...ordinary,id:'older-archive',conversationId:'older-chat',chatIds:['older-chat'],title:'Earlier archived',
    archivedAt:now-5000,updatedAt:now-5000,events:2,projectId:'project-keep'};
  const rows=[ordinary,worker,second];
  const historyById = new Map([[ordinary.id,structuredClone(f.events)], [worker.id,[{seq:1,kind:'note',message:{text:'Worker report',truncated:false,chars:13}}]]]);
  const archiveActions = [];
  window.archiveSmoke={rows,historyById,archiveActions};
  const methods={
    getState:async()=>{const r=await original.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);
      r.data.config.ui={...r.data.config.ui,language:'en'};return r;},
    listSessions:async options=>{
      const archived=options?.archived===true;
      let found=rows.filter(s=>Boolean(s.archivedAt)===archived);
      if(options?.search)found=found.filter(s=>s.title.toLowerCase().includes(options.search.toLowerCase()));
      found.sort((a,b)=>b.updatedAt-a.updatedAt);
      if(options?.cursor)found=found.filter(s=>s.updatedAt<options.cursor.updatedAt ||
        (s.updatedAt===options.cursor.updatedAt && s.id<options.cursor.id));
      const total=rows.filter(s=>Boolean(s.archivedAt)===archived &&
        (!options?.search||s.title.toLowerCase().includes(options.search.toLowerCase()))).length;
      const page=found.slice(0,1),hasMore=found.length>1;
      return ok({sessions:page,total,nextCursor:hasMore?{updatedAt:page[0].updatedAt,id:page[0].id}:null,activeId:ordinary.id,pressure:[],blocked:[]});
    },
    archiveSession:async (id,archived)=>{
      const row=rows.find(x=>x.id===id);
      if(!row)return {ok:false,error:'Unknown fixture session'};
      archiveActions.push({id,archived});
      if(archived)row.archivedAt=Date.now();else delete row.archivedAt;
      f.notify();return ok(row);
    },
    getSession:async id=>{
      const row=rows.find(x=>x.id===id);
      if(!row)return {ok:false,error:'Unknown fixture session'};
      const events=historyById.get(id)??[];
      return ok({summary:row,events,total:events.length,nextFrom:events.length+1});
    }
  };
  window.api=new Proxy(methods,{get:(target,key)=>Object.prototype.hasOwnProperty.call(target,key)?target[key]:original[key]});
})();`;
app.whenReady().then(async () => {
  server = await createServer({configFile:false,root:path.join(root,'src/renderer'),
    cacheDir:path.join(temp,'vite'),logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'local-archive-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/archive-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{
        if(req.url!=='/archive-fixture.js')return next();
        res.setHeader('Content-Type','text/javascript');
        res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);
      });}}]});
  await server.listen();
  win=new BrowserWindow({show:false,width:1400,height:960,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(let end=Date.now()+18000;Date.now()<end;){if(await js(expression))return;await pause(75);}throw Error('Timed out: '+expression);};
  await win.loadURL(server.resolvedUrls.local[0]);
  await until("document.querySelector('.sess[data-id=\"composer-preview\"] .sess-menu')!==null");
  assert.equal(await js("document.querySelectorAll('#archivesList .sess').length"),0);
  await js("document.querySelector('.sess[data-id=\"composer-preview\"] .sess-menu').click()");
  await until("document.querySelector('.row-menu [data-row-action=\"archive\"]')!==null");
  await js("document.querySelector('.row-menu [data-row-action=\"archive\"]').click()");
  await until("!document.querySelector('#chatList .sess[data-id=\"composer-preview\"]')");
  await js("document.getElementById('archivesSection').open=true");
  await until("document.querySelector('#archivesList .sess')!==null");
  assert.equal(await js("document.getElementById('archivesCount').textContent"),'3');
  assert.equal(await js("document.getElementById('archivesMore').hidden"),false);
  await js("document.getElementById('archivesMore').click()");
  await until("document.querySelectorAll('#archivesList .sess').length===2");
  await js("document.getElementById('archivesSearch').value='Standalone';document.getElementById('archivesSearch').dispatchEvent(new Event('input',{bubbles:true}))");
  await until("document.querySelectorAll('#archivesList .sess').length===1 && document.querySelector('#archivesList .sess[data-id=\"composer-preview\"]')");
  await js("document.querySelector('#archivesList .sess[data-id=\"composer-preview\"] .sess-menu').click()");
  await until("document.querySelector('.row-menu [data-row-action=\"restore\"]')!==null");
  await js("document.querySelector('.row-menu [data-row-action=\"restore\"]').click()");
  await until("document.querySelector('.sess[data-id=\"composer-preview\"]')!==null && !document.querySelector('#archivesList .sess[data-id=\"composer-preview\"]')");
  const outcome=await js("({actions:window.archiveSmoke.archiveActions,project:window.archiveSmoke.rows[0].projectId,transcript:window.archiveSmoke.historyById.get('composer-preview').length,workerStillArchived:!!window.archiveSmoke.rows[1].archivedAt})");
  assert.deepEqual(outcome.actions,[{id:'composer-preview',archived:true},{id:'composer-preview',archived:false}]);
  assert.equal(outcome.project,null);
  assert.equal(outcome.transcript,2);
  assert.equal(outcome.workerStillArchived,true);
  assert.deepEqual(errors,[]);
  console.log('PASS Electron synthetic local archive: row menu -> hidden main list -> Archived count/page/search -> restore same session and history.');
  win.destroy();await server.close();fs.rmSync(temp,{recursive:true,force:true});app.exit(0);
}).catch(async error=>{console.error(error);if(win&&!win.isDestroyed())win.destroy();await server?.close();fs.rmSync(temp,{recursive:true,force:true});app.exit(1);});
