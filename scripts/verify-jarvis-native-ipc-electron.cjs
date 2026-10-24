/**
 * Real Electron preload/contextBridge + real main Jarvis audio IPC, with a synthetic
 * browser delivery service. Does NOT replace window.api in the renderer, access a real
 * microphone or ChatGPT account, or start the production Electron app.
 *
 * Run: env -u ELECTRON_RUN_AS_NODE node_modules/electron/dist/electron --no-sandbox scripts/verify-jarvis-native-ipc-electron.cjs
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'marks-jarvis-real-ipc-'));
const { defaultConfig, merge, BENIGN_RENDERER_ERRORS } = require('./fixtures/app-defaults.cjs');
process.env.HOME = path.join(temp, 'home');
process.env.XDG_CONFIG_HOME = path.join(temp, 'config');
process.env.XDG_CACHE_HOME = path.join(temp, 'cache');
process.env.XDG_DATA_HOME = path.join(temp, 'data');
for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME']) mkdirSync(process.env[key], {recursive:true});
app.setPath('userData', path.join(temp, 'userData'));
app.disableHardwareAcceleration();

// Bundle only the production handler and its injectable voice-provider adapter.
// Both run in Electron MAIN and own a real ipcMain.handle('jarvis:audio').
const wrapper = path.join(root, '.tmp/jarvis-gpt-ui-qa/real-ipc-gate-entry.ts');
const bundled = path.join(root, '.tmp/jarvis-gpt-ui-qa/real-ipc-gate-entry.cjs');
mkdirSync(path.dirname(wrapper), {recursive:true});
writeFileSync(wrapper, "export { registerJarvisAudioIpc } from '../../src/main/jarvis-audio.js';\nexport { configureJarvisVoiceForTests } from '../../src/main/jarvis-voice.js';\n");
esbuild.buildSync({ entryPoints:[wrapper], outfile:bundled, bundle:true, platform:'node', format:'cjs', packages:'external', external:['electron'], logLevel:'error' });
const { registerJarvisAudioIpc, configureJarvisVoiceForTests } = require(bundled);

// The stable source fixture models a normal native ChatGPT conversation. Its
// methods are MAIN process IPC backends only; the browser receives its ORIGINAL
// compiled production preload, not this fixture's window.api object.
const fakeWindow = {};
vm.runInNewContext(readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8'),
  {window:fakeWindow,structuredClone,console,setTimeout,clearTimeout,Date,Promise});
fakeWindow.composerFixture.summary.title='Native ChatGPT / synthetic IPC';
fakeWindow.composerFixture.summary.selectedModel.model='gpt-6-sol';
const backend = fakeWindow.api;
const config = defaultConfig();

let win=null, vite=null, failedFallback=false;
const reqs={ audio:[], speech:[], tries:[], sends:[], interrupted:0 };
const fakeGemini=process.env.JARVIS_GEMINI_STT_REGRESSION==='1';
const voiceBase=fakeGemini?'https://generativelanguage.googleapis.com/v1beta':'http://127.0.0.1:18789/v1'; // Network is always intercepted.
const voice={baseUrl:voiceBase, sttMode:'transcriptions', sttModel:fakeGemini?'gemini-3.5-transcribe':'whisper-1',
  ttsModel:fakeGemini?'gemini-3.8-flash-tts':'gpt-4o-mini-tts', voice:fakeGemini?'Charon':'alloy'};
const respond=(body,headers={})=>new Response(body,{status:200,headers});
configureJarvisVoiceForTests({
  ffmpeg:async()=>false,
  credential:async slot=>({header:fakeGemini?'x-goog-api-key':'Authorization',value:slot==='primary'?'synthetic-primary':'synthetic-fallback'}),
  fetch:async (url,init)=>{
    const route=new URL(url).pathname;
    const key=String(init.headers.Authorization??init.headers['x-goog-api-key']??'');
    reqs.tries.push({route,key:key==='Bearer synthetic-primary'||key==='synthetic-primary'?'primary':'fallback'});
    if (route.endsWith('/models')) return respond(JSON.stringify({data:[{id:'whisper-1'},{id:'gpt-4o-mini-tts'}]}),{'content-type':'application/json'});
    if (key==='Bearer synthetic-primary' || key==='synthetic-primary' || failedFallback) return new Response(JSON.stringify({error:{message:'synthetic outage'}}),{status:503,headers:{'content-type':'application/json'}});
    if (fakeGemini && route.endsWith('/interactions')) {
      const body=JSON.parse(init.body);
      if (body.model==='gemini-3.5-transcribe') {
        assert.equal(body.input[0].type,'audio');
        assert.equal(body.input[0].mime_type,'audio/webm');
        assert.deepEqual(body.generation_config.transcription_config.language_codes,['pt-BR']);
        assert.ok(body.input[0].data,'microphone capture must go directly to Gemini Interactions');
        reqs.audio.push(route);
        return Response.json({output_text:'Pergunta normal via STT real IPC.'});
      }
      if (body.model==='gemini-3.8-flash-tts') {
        reqs.speech.push(body.input[0].content[0].text);
        return Response.json({steps:[{type:'model_output',content:[{type:'audio',data:Buffer.from('RIFF-synthetic-gemini-voice').toString('base64')}]}]});
      }
      throw Error('Unexpected synthetic Gemini model');
    }
    if (route.endsWith('/audio/transcriptions')) {
      reqs.audio.push(route);
      return respond(JSON.stringify({text:'Pergunta normal via STT real IPC.'}),{'content-type':'application/json'});
    }
    if (route.endsWith('/audio/speech')) {
      const body=JSON.parse(init.body);
      reqs.speech.push(body.input);
      return respond(new Uint8Array([73,68,51,3,0,0,0,0,0,0,20]),{'content-type':'audio/mpeg'});
    }
    throw Error('Unrecognized synthetic route: '+route);
  }
});
const synthetic = {
  'state:get':async()=>{const result=await backend.getState();result.data.config=merge(config,result.data.config);result.data.config.ui={...result.data.config.ui,language:'en',theme:'dark'};return result;},
  'sessions:list':async()=>{const result=await backend.listSessions();result.data={...result.data,blocked:[],approval:[],recoveryStopped:[],trusted:[],total:1,nextCursor:null};return result;},
  'sessions:events':()=>backend.getSession(),
  'projects:list':()=>backend.listProjects(),
  'sessions:controls':()=>backend.getSessionControls(),
  'sessions:inputs':()=>backend.listInputs(),
  'sessions:outbox':()=>backend.listInputs(),
  'chatModels:get':()=>backend.getChatModels(),
  'chatModels:request':()=>backend.requestChatModels(),
  'chatGroups:get':()=>({ok:true,data:{groups:[],memberships:{}}}),
  'vault:status':()=>({ok:true,data:{ready:false,locked:true}}),
  'vault:list':()=>({ok:true,data:[]}),
  'remoteHosts:list':()=>({ok:true,data:[]}),
  'remoteHosts:pending':()=>({ok:true,data:[]}),
  'sessions:send':async payload=>{
    reqs.sends.push({id:payload.id,sessionId:payload.sessionId,text:payload.text});
    assert.equal(payload.sessionId,'composer-preview','voice input must target existing normal chat');
    assert.equal(payload.mode,'auto');
    const result=await backend.sendInput(payload);
    if(payload.text==='Mensagem digitada para Jarvis'){
      setTimeout(()=>{
        fakeWindow.composerFixture.events.push(
          {seq:201,kind:'user_message',messageId:'typed-question',inputId:payload.id,inputDelivery:'confirmed',turnId:'typed-user-turn',message:{text:payload.text,truncated:false,chars:payload.text.length}},
          {seq:202,kind:'assistant_message',turnId:'typed-answer-turn',messageId:'typed-answer',message:{text:'A resposta digitada chegou corretamente.',truncated:false,chars:39},final:true},
          {seq:203,kind:'turn_end',turnId:'typed-answer-turn',outcome:'completed'}
        );
        fakeWindow.composerFixture.summary.timelineTurns={
          ...fakeWindow.composerFixture.summary.timelineTurns,
          'typed-answer-turn':{origin:201,time:Date.now(),questionId:'typed-question'}
        };
        if(win&&!win.isDestroyed())win.webContents.send('session:changed',{sessionIds:['composer-preview']});
      },100);
      return result;
    }
    setTimeout(()=>{
      fakeWindow.composerFixture.events.push(
        {seq:100,kind:'assistant_message',turnId:'not-jarvis-turn',messageId:'wrong',message:{text:'Do not speak a different turn.',truncated:false,chars:30},final:false},
        {seq:101,kind:'user_message',inputId:payload.id,inputDelivery:'offered',turnId:'unconfirmed',message:{text:payload.text,truncated:false,chars:payload.text.length}},
        {seq:102,kind:'user_message',messageId:'confirmed-question',inputId:payload.id,inputDelivery:'confirmed',turnId:'native-user-turn',message:{text:payload.text,truncated:false,chars:payload.text.length}},
        {seq:103,kind:'assistant_message',turnId:'confirmed-turn',messageId:'confirmed-answer',message:{text:'A resposta certa veio do ChatGPT.',truncated:false,chars:33},final:true},
        {seq:104,kind:'turn_end',turnId:'confirmed-turn',outcome:'completed'}
      );
      fakeWindow.composerFixture.summary.timelineTurns={
        'confirmed-turn':{origin:102,time:Date.now(),questionId:'confirmed-question'}
      };
      if(win&&!win.isDestroyed())win.webContents.send('session:changed',{sessionIds:['composer-preview']});
    },100);
    return result;
  }
};

const preloadSource=readFileSync(path.join(root,'src/preload/index.ts'),'utf8');
const channels=new Set([...preloadSource.matchAll(/['"]([a-zA-Z][\w-]*:[\w-]+)['"]/g)].map(m=>m[1]));
// The preload also has precisely typed namespaced actions with a dynamic suffix.
for (const channel of ['vault:status','vault:list','vault:pending','remoteHosts:list','remoteHosts:pending']) channels.add(channel);
const allowedChannels=[...channels].filter(channel=>channel!=='jarvis:audio');
const rendererFixture=`(() => {
  localStorage.setItem('cos.ui.language','en');
  localStorage.setItem('chat-marks.jarvis.settings.v1',JSON.stringify({version:2,enabled:false,tts:false,earcons:false,language:${JSON.stringify(fakeGemini?'pt-BR':'')},
    provider:${JSON.stringify(voice)}}));
  let stops=0, plays=0;
  window.jarvisHardwareFake={get stops(){return stops;},get plays(){return plays;}};
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>stops++}]})}});
  window.MediaRecorder=class {
    static isTypeSupported(){return true;}
    constructor(){this.state='inactive';this.onstop=null;this.ondataavailable=null;}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['not-a-real-recording'],{type:'audio/webm'})});this.onstop?.();}
  };
  Object.defineProperty(window,'MediaSource',{configurable:true,value:undefined});
  URL.createObjectURL=()=> 'blob:synthetic-real-ipc';URL.revokeObjectURL=()=>{};
  window.Audio=class {constructor(){this.paused=true;this.onended=null;this.onplaying=null;}
    play(){this.paused=false;plays++;queueMicrotask(()=>{this.onplaying?.();this.paused=true;this.onended?.();});return Promise.resolve();}
    pause(){this.paused=true;}removeAttribute(){}load(){} };
})();`;

app.whenReady().then(async()=>{
  const {createServer}=await import('vite');
  vite=await createServer({configFile:false,root:path.join(root,'src/renderer'),cacheDir:path.join(temp,'vite'),logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,require('node:fs').realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'jarvis-real-ipc-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/jarvis-hardware-fake.js"></script></head>'),
      configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/jarvis-hardware-fake.js')return next();res.setHeader('Content-Type','text/javascript');res.end(rendererFixture);});}}]});
  await vite.listen();
  win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{preload:path.join(root,'out/preload/index.js'),contextIsolation:true,nodeIntegration:false,sandbox:true,offscreen:true,backgroundThrottling:false}});
  registerJarvisAudioIpc(()=>win);
  for (const channel of allowedChannels){
    ipcMain.handle(channel,(_event,payload)=>{
      const handler=synthetic[channel];
      try {return handler?handler(payload):{ok:false,error:'Synthetic main fixture has no handler for '+channel};}
      catch(error){return {ok:false,error:error.message};}
    });
  }
  const consoleErrors=[];
  win.webContents.on('console-message',event=>{if(event.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(event.message))consoleErrors.push(event.message);});
  const js=source=>win.webContents.executeJavaScript(source);
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const until=async(condition,ms=15000)=>{for(const deadline=Date.now()+ms;Date.now()<deadline;){if(await js(condition))return;await pause(60);}throw Error('timeout '+condition);};
  await win.loadURL(vite.resolvedUrls.local[0]);
  await until('Boolean(window.api?.jarvisTranscribe && window.api?.sendInput && window.api?.jarvisSpeakStream)');
  // Assert the API really came from compiled preload and that no raw ipcRenderer leaks.
  assert.equal(await js('Boolean(window.ipcRenderer)'),false);
  await pause(700);
  await js('document.getElementById("backToChat")?.click()');
  await until('Boolean(document.querySelector(`[data-id="composer-preview"]`))');
  await js('document.querySelector(`[data-id="composer-preview"]`).click()');
  await until('document.getElementById("jarvisTalk").hidden===false');
  assert.equal(await js('document.getElementById("jarvisTalk").disabled'),true);
  await js('document.getElementById("jarvisSetupChat").click()');
  await until('document.querySelector(`[data-panel="jarvis"]`).classList.contains("is-active")');
  assert.match(await js('document.getElementById("jarvisModelInfo").textContent'),/gpt-6-sol/);
  assert.match(await js('document.getElementById("jarvisActiveChat").textContent'),/Native ChatGPT/);
  await js(`(()=>{for(const id of ['jarvisEnabled','jarvisConsent','jarvisTts']){const e=document.getElementById(id);e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await until('document.getElementById("jarvisTalk").disabled===false');
  await js('document.getElementById("jarvisGoToChat").click()');
  await until('document.querySelector(".app").dataset.screen==="chat"');
  await js('document.getElementById("chatInput").dispatchEvent(new KeyboardEvent("keydown",{code:"F8",bubbles:true}))');
  await pause(100);
  await js('window.dispatchEvent(new KeyboardEvent("keyup",{code:"F8",bubbles:true}))');
  await until('window.jarvisHardwareFake.plays>=1');
  assert.equal(reqs.sends.length,1);
  assert.equal(reqs.audio.length,1);
  assert.deepEqual(reqs.speech,['A resposta certa veio do ChatGPT.']);
  const sttPath=fakeGemini?'/interactions':'/audio/transcriptions';
  assert.ok(reqs.tries.some(e=>e.route.endsWith(sttPath)&&e.key==='primary'));
  assert.ok(reqs.tries.some(e=>e.route.endsWith(sttPath)&&e.key==='fallback'));
  assert.ok((await js('window.jarvisHardwareFake.stops'))>=1);
  const first=JSON.stringify({ipc:'real preload+jarvis main',audio:reqs.audio.length,spoken:reqs.speech,sends:reqs.sends.length,fallback:reqs.tries.filter(e=>e.key==='fallback').length});
  // Opt-in P0 regression: a normal typed send must also trigger Jarvis TTS,
  // with no extra microphone capture. Keep independent from the legacy mic gate
  // while this behavior is being implemented by the Jarvis owner.
  if(process.env.JARVIS_TYPED_TTS_REGRESSION==='1'){
    const beforeAudio=reqs.audio.length;
    const input=await js('document.getElementById("chatInput")');
    assert.ok(input,'normal chat composer must exist');
    await js(`(()=>{const el=document.getElementById('chatInput');el.value='Mensagem digitada para Jarvis';el.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('chatSend').click();})()`);
    await until('window.api && document.getElementById("chatInput")',5000);
    assert.equal(reqs.audio.length,beforeAudio,'typed message must not start STT');
    await until('window.jarvisHardwareFake.plays>=2',5000);
    assert.equal(reqs.speech.length,2,'typed response should be voiced once');
  }
  // Even a configured provider that fails both keys must not queue a second native input.
  failedFallback=true;
  await js('document.getElementById("chatInput").dispatchEvent(new KeyboardEvent("keydown",{code:"F8",bubbles:true}))');
  await pause(100);
  await js('window.dispatchEvent(new KeyboardEvent("keyup",{code:"F8",bubbles:true}))');
  await until('document.getElementById("jarvisSettingsStatus").textContent.includes("503")');
  assert.equal(reqs.sends.length,process.env.JARVIS_TYPED_TTS_REGRESSION==='1'?2:1,'failed STT cannot queue a second message');
  assert.deepEqual(consoleErrors,[]);
  console.log('PASS multiprocess '+first+' + failure fail-closed STT'+(fakeGemini?' via Gemini PT-BR Interactions':'')+'; no real mic, account or provider');
  win.destroy();await vite.close();rmSync(temp,{recursive:true,force:true});app.exit(0);
}).catch(async error=>{console.error(error);if(win&&!win.isDestroyed())win.destroy();await vite?.close();rmSync(temp,{recursive:true,force:true});app.exit(1);});
