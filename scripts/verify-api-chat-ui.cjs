// Production renderer and real Chromium layout/input; synthetic data only.
// Chat Marks API chats in the normal chat view: New chat offers CLIProxy after ChatGPT, the created
// chat opens in the timeline with its own model selector instead of ChatGPT's, the composer sends
// through apiChatSend (never the ChatGPT outbox) and the answer shows in the same timeline.
// D4: a second turn calls a local tool (its recorded row shows in the timeline) and pauses on an
// edit: the approval card shows the tool and its files, and Approve answers that exact approval.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'api-chat-ui'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 // The same language on every runner, whatever the system language is.
 try{localStorage.setItem('cos.ui.language','en');}catch{}
 const old=window.api,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 const apiId='api-chat-preview',conversationId='cosapi-00000000-0000-4000-8000-000000000001';
 const status={endpoint:'http://127.0.0.1:18081/v1',model:'claude-sonnet-5-5',effort:null,favorites:['claude-opus-5-5'],recents:['claude-sonnet-5-5'],hasKey:true,detected:true,keyRequired:false};
 const view={sessionId:apiId,conversationId,model:'claude-sonnet-5-5',effort:null,running:false,approval:'ask',pending:null};
 const row=(id,ownedBy,modality='chat')=>({id,ownedBy,modality,favorite:status.favorites.includes(id),recent:status.recents.includes(id),availability:null});
 const events=[];let created=false,seq=0;
 const message=text=>({text,truncated:false,chars:text.length});
 const summary=()=>({...composerFixture.summary,id:apiId,title:'Plan a reading list',conversationId,chatIds:[conversationId],selectedModel:null,
  events:events.length,userMessages:events.filter(e=>e.kind==='user_message').length,activeTurnId:null,lastTurnOutcome:events.length?'completed':null,
  estimatedTokens:0,contextTokens:0,startedAt:Date.now()-1000,updatedAt:Date.now()+seq});
 const changed=()=>composerFixture.emit('onSessionChanged',{sessionIds:[apiId]});
 window.apiChatFixture={sent:[],createdWith:null,outbox:0,settings:[],approvals:[]};
 const text=value=>({text:value,truncated:false,chars:value.length});
 // The second message: the model reads a file through the kernel (its row), then asks to patch.
 const toolTurn=(turnId,question,now)=>{
  events.push({seq:events.length+1,time:now,source:'app',kind:'turn_start',turnId},
   {seq:events.length+2,time:now,source:'app',kind:'user_message',messageId:'api-user:'+turnId,turnId,message:message(question)},
   {seq:events.length+3,time:now+1,source:'app',kind:'assistant_message',messageId:'api-assistant:'+turnId,turnId,state:'final',final:true,message:message('Let me read the notes first.')},
   {seq:events.length+4,time:now+2,source:'mcp',kind:'tool_call',call:{callId:'api-tool-1',tool:'read',requestId:'cosapi:00000000-0000-4000-8000-000000000009',
    conversationId,attributionMethod:'request_id',args:text('{"paths":["/work/notes.md"]}'),result:text('1: # Reading notes\\n2: Start with design books.'),
    outcome:'ok',durationMs:12,attribution:'request_id',summary:{kind:'read',title:'Read notes.md',tone:'neutral'}}});
  view.running=true;
  view.pending={approvalId:'0f1e2d3c-aaaa-4bbb-8ccc-0123456789ab',turnId,toolCallId:'call_patch',tool:'apply_patch',summary:'7 patch lines',
   files:['update /work/notes.md','add /work/reading-list.md'],requestedAt:now+3};
 };
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en',theme:'dark'};return r;},
  apiChatStatus:()=>ok(status),
  apiChatModels:()=>ok({models:[row('claude-opus-5-5','anthropic'),row('claude-sonnet-5-5','anthropic'),row('gpt-6-sol','openai'),row('gpt-image-2','openai','image')],total:4}),
  apiChatCreate:options=>{created=true;window.apiChatFixture.createdWith=options;changed();return ok(view);},
  apiChatChatSettings:()=>ok(view),
  apiChatSetChatSettings:(_id,patch)=>{window.apiChatFixture.settings.push(patch);Object.assign(view,patch);return ok(view);},
  apiChatStop:()=>ok({stopped:false}),
  apiChatApprove:(_id,approvalId,decision)=>{
   window.apiChatFixture.approvals.push({approvalId,decision});
   const turnId=view.pending?.turnId,now=Date.now();view.pending=null;view.running=false;
   events.push({seq:events.length+1,time:now,source:'app',kind:'assistant_message',messageId:'api-assistant:'+turnId+':1',turnId,state:'final',final:true,message:message('Saved the list to reading-list.md.')},
    {seq:events.length+2,time:now+1,source:'app',kind:'turn_end',turnId,outcome:'completed'});
   setTimeout(changed,50);
   return ok(view);
  },
  apiChatSend:(_id,text)=>{
   window.apiChatFixture.sent.push(text);
   const turnId='api-turn-'+(++seq),now=Date.now();
   if(seq===2){toolTurn(turnId,text,now);setTimeout(changed,50);return ok({turnId});}
   events.push({seq:events.length+1,time:now,source:'app',kind:'turn_start',turnId},
    {seq:events.length+2,time:now,source:'app',kind:'user_message',messageId:'api-user:'+turnId,turnId,message:message(text)},
    {seq:events.length+3,time:now+1,source:'app',kind:'assistant_message',messageId:'api-assistant:'+turnId,turnId,state:'final',final:true,
     message:message('Here is a short reading list:\\n\\n1. **The Pragmatic Programmer** — habits that age well.\\n2. **Designing Data-Intensive Applications** — how real systems store and move data.\\n3. **A Philosophy of Software Design** — keeping complexity down.')},
    {seq:events.length+4,time:now+2,source:'app',kind:'turn_end',turnId,outcome:'completed'});
   setTimeout(changed,50);
   return ok({turnId});
  },
  // The ChatGPT outbox must never see an API chat's message.
  sendInput:input=>{window.apiChatFixture.outbox++;return old.sendInput(input);},
  listSessions:async options=>{const r=await old.listSessions(options);if(created)r.data.sessions=[summary(),...r.data.sessions];return r;},
  getSession:(id,options)=>id===apiId?ok({summary:summary(),events,total:events.length,nextFrom:events.length+1}):old.getSession(id,options)
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'api-chat-ui-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/timeline-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}] });
  await server.listen();
  win = new BrowserWindow({show:false,width:1280,height:800,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+15000;Date.now()<deadline;){if(await js(expression))return;await pause(40);}throw new Error('Timed out: '+expression);};
  const settle=async()=>{await js(`document.getAnimations().forEach(a=>{if(a.effect.getTiming().iterations!==Infinity)a.finish()})`);await pause(180);};
  const capture=async name=>{await settle();fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  const shown=id=>`(()=>{const n=document.getElementById('${id}');return !!n&&getComputedStyle(n).display!=='none'&&!n.closest('[hidden]');})()`;
  await win.loadURL(server.resolvedUrls.local[0]);
  await until(`document.getElementById('newChat')?.getAttribute('aria-haspopup')==='menu'`);
  win.show(); win.focus(); win.webContents.focus(); await pause(100);
  await js(`document.getElementById('newChat').click()`);
  await until(`!!document.querySelector('.row-menu [data-row-action="new-chat-cliproxy"]')`);
  assert.deepEqual(await js(`[...document.querySelectorAll('.row-menu [data-row-action^="new-chat-"]')].map(b=>b.dataset.rowAction+'='+b.textContent.trim())`),
    ['new-chat-chatgpt=ChatGPT','new-chat-cliproxy=CLIProxy']);
  await capture('api-chat-menu.png');
  await js(`document.querySelector('.row-menu [data-row-action="new-chat-cliproxy"]').click()`);
  await until(`document.querySelector('[data-panel="chat"]').classList.contains('is-api-chat')`);
  await until(`document.querySelector('.sess[data-id="api-chat-preview"]')!==null`);
  assert.deepEqual(await js(`window.apiChatFixture.createdWith`),{projectId:null});
  await until(`document.getElementById('apiChatLabel')?.textContent==='CLIProxy · claude-sonnet-5-5'`);
  await until(`document.querySelectorAll('#apiChatComposerModel option').length===3`);
  assert.equal(await js(shown('apiChatComposerModel')),true,'The CLIProxy model selector is on screen');
  assert.deepEqual(await js(`[...document.querySelectorAll('#apiChatComposerModel option')].map(o=>o.value)`),['claude-opus-5-5','claude-sonnet-5-5','gpt-6-sol'],'Chat models only, favorites first');
  for (const id of ['modelMenu','attachmentMenu','composerSettings','createPlan','contextMeter']) assert.equal(await js(shown(id)),false,id+' is hidden in an API chat');
  await js(`(()=>{const s=document.getElementById('apiChatComposerEffort');s.value='high';s.dispatchEvent(new Event('change'));})()`);
  await until(`window.apiChatFixture.settings.some(p=>p.effort==='high')`);
  await js(`(()=>{const i=document.getElementById('chatInput');i.focus();i.value='Suggest three books about software design.';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await js(`document.getElementById('chatSend').click()`);
  await until(`window.apiChatFixture.sent.length===1`);
  assert.deepEqual(await js(`window.apiChatFixture.sent`),['Suggest three books about software design.']);
  await until(`document.getElementById('chatInput').value===''`);
  await until(`document.getElementById('timeline').textContent.includes('Designing Data-Intensive Applications')`);
  assert.match(await js(`document.getElementById('timeline').textContent`),/Suggest three books about software design\./);
  assert.equal(await js(`window.apiChatFixture.outbox`),0,'The ChatGPT outbox never saw the message');
  await capture('api-chat.png');
  // D4: a turn that used a local tool and now waits on an edit.
  assert.equal(await js(`document.getElementById('apiChatComposerApproval').value`),'ask','Edits and commands ask by default');
  await js(`(()=>{const i=document.getElementById('chatInput');i.focus();i.value='Save that list next to my notes.';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await js(`document.getElementById('chatSend').click()`);
  await until(`window.apiChatFixture.sent.length===2`);
  await until(`document.getElementById('timeline').textContent.includes('Let me read the notes first.')`);
  await until(`document.getElementById('timeline').textContent.includes('Read notes.md')`);
  await until(shown('apiChatApproval'));
  const card=await js(`document.getElementById('apiChatApproval').textContent`);
  for (const part of ['Approve this action?','apply_patch','update /work/notes.md','add /work/reading-list.md',"Approve and don't ask again in this chat"]) assert.ok(card.includes(part),'Approval card shows '+part);
  await capture('api-chat-approval.png');
  await js(`document.querySelector('#apiChatApproval [data-decision="approve"]').click()`);
  await until(`window.apiChatFixture.approvals.length===1`);
  assert.deepEqual(await js(`window.apiChatFixture.approvals`),[{approvalId:'0f1e2d3c-aaaa-4bbb-8ccc-0123456789ab',decision:'approve'}]);
  await until(`!(${shown('apiChatApproval')})`);
  await until(`document.getElementById('timeline').textContent.includes('Saved the list to reading-list.md.')`);
  await capture('api-chat-tools.png');
  // Back to a ChatGPT chat: its controls return.
  await js(`document.querySelector('.sess[data-id="composer-preview"] .sess-top, .sess[data-id="composer-preview"]')?.click()`);
  await until(`!document.querySelector('[data-panel="chat"]').classList.contains('is-api-chat')`);
  assert.equal(await js(shown('modelMenu')),true,'The ChatGPT model menu returns for a ChatGPT chat');
  assert.deepEqual(errors,[]);
  console.log('PASS: New chat creates a CLIProxy chat that sends through apiChatSend, shows its answer and tool row in the normal timeline, and answers an edit approval');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
