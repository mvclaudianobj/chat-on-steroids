// Electron Chromium renderer + real chat module + synthetic IPC/bridge and audio.
// A disposable HOME/XDG is supplied by the runner; this file never requests hardware.
const { app, BrowserWindow } = require('electron');
const { createServer } = require('vite');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require('./fixtures/app-defaults.cjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marks-jarvis-native-ui-'));
app.setPath('userData', path.join(temp, 'userData'));
app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
  localStorage.setItem('cos.ui.language','en');
  localStorage.setItem('chat-marks.jarvis.settings.v1', JSON.stringify({enabled:false,tts:false,engine:'auto',version:2,earcons:false,
    provider:{baseUrl:'https://synthetic.voice.test/v1',sttMode:'transcriptions',sttModel:'whisper-1',ttsModel:'fake-tts',voice:'alloy'}}));
  const orig=window.api;
  const f=window.composerFixture;
  f.summary.title='Normal ChatGPT test conversation';
  f.summary.selectedModel.model='gpt-6-sol';
  let stops=0;
  const metrics={sends:[],spoken:[],stt:[],get microphoneStops(){return stops;}};
  window.jarvisNativeSmoke=metrics;
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>{stops++;}}]})}});
  class Recorder {
    static isTypeSupported(){return true;}
    constructor(){this.state='inactive';this.ondataavailable=null;this.onstop=null;}
    start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['synthetic webm'],{type:'audio/webm'})});this.onstop?.();}
  }
  window.MediaRecorder=Recorder;
  URL.createObjectURL=()=> 'blob:synthetic-jarvis';
  URL.revokeObjectURL=()=>{};
  window.Audio=class {play(){Promise.resolve().then(()=>this.onended?.());return Promise.resolve();} pause(){} };
  const ok=data=>Promise.resolve({ok:true,data});
  const methods={
    getState:async()=>{const r=await orig.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'en'};return r;},
    dictationSupported:false,
    jarvisAudioStatus:()=>ok({models:[],local:false,windows:false,error:null}),
    jarvisVoiceStatus:()=>ok({primary:true,fallback:false,ffmpeg:true,stt:['whisper-1'],tts:['fake-tts'],error:null}),
    jarvisTranscribe:async (...args)=>{metrics.stt.push(args[0]);return {ok:true,data:'Pergunta ditada com voz sintética.'};},
    jarvisSpeak:async (_provider,text)=>{metrics.spoken.push(text);return {ok:true,data:{mime:'audio/mpeg',bytes:new Uint8Array([1,2,3])}};},
    jarvisSpeakStream:undefined,onJarvisSpeechStream:undefined,
    jarvisSpeakCancel:()=>ok(null),jarvisCancel:()=>ok(null),
    sendInput:async input=>{
      metrics.sends.push({id:input.id,text:input.text,sessionId:input.sessionId});
      const reply=await orig.sendInput(input);
      setTimeout(()=>{
        f.events.push({seq:200,kind:'assistant_message',turnId:'unrelated-turn',messageId:'other',message:{text:'Other turn must not speak.',truncated:false,chars:26},final:false});
        f.events.push({seq:201,kind:'user_message',inputId:input.id,inputDelivery:'confirmed',turnId:'native-jarvis-turn',message:{text:input.text,truncated:false,chars:input.text.length}});
        f.events.push({seq:202,kind:'assistant_message',turnId:'native-jarvis-turn',messageId:'jarvis-answer',message:{text:'Correct native answer. Continues',truncated:false,chars:30},final:false});
        f.notify();
      },150);
      return reply;
    }
  };
  window.api=new Proxy(methods,{get:(target,key)=>Object.prototype.hasOwnProperty.call(target,key)?target[key]:orig[key]});
})();`;

app.whenReady().then(async () => {
  server = await createServer({configFile:false,root:path.join(root,'src/renderer'),cacheDir:path.join(temp,'vite'),logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'jarvis-native-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/native-fixture.js"></script></head>'),
      configureServer(vite){vite.middlewares.use((req,res,next)=>{
        if(req.url!=='/native-fixture.js')return next();
        res.setHeader('Content-Type','text/javascript');
        res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);
      });}}]});
  await server.listen();
  win=new BrowserWindow({show:false,width:1200,height:860,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',event=>{if(event.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(event.message))errors.push(event.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const deadline=Date.now()+18000;Date.now()<deadline;){if(await js(expression))return;await pause(80);}throw Error('Timed out: '+expression);};
  await win.loadURL(server.resolvedUrls.local[0]);
  await pause(300);
  await js(`document.querySelector('[data-id="composer-preview"]')?.click()`);
  await until(`document.getElementById('jarvisTalk')?.hidden===false`);
  assert.equal(await js(`document.getElementById('jarvisTalk').disabled`),true);
  assert.equal(await js(`document.getElementById('jarvisSetupChat').hidden`),false);
  await js(`document.getElementById('jarvisSetupChat').click()`);
  await until(`document.querySelector('[data-panel="jarvis"]').classList.contains('is-active')`);
  assert.match(await js(`document.getElementById('jarvisActiveChat').textContent`),/Normal ChatGPT test conversation/);
  assert.match(await js(`document.getElementById('jarvisModelInfo').textContent`),/gpt-6-sol/);
  await js(`(()=>{for(const id of ['jarvisEnabled','jarvisConsent','jarvisTts']){const e=document.getElementById(id);e.checked=true;e.dispatchEvent(new Event('change',{bubbles:true}));}})()`);
  await until(`document.getElementById('jarvisTalk').disabled===false`);
  await js(`document.getElementById('jarvisGoToChat').click()`);
  await until(`document.querySelector('.app')?.dataset.screen==='chat'`);
  await js(`document.getElementById('chatInput').dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,code:'F8'}))`);
  await pause(100);
  await js(`window.dispatchEvent(new KeyboardEvent('keyup',{bubbles:true,code:'F8'}))`);
  await until(`window.jarvisNativeSmoke?.spoken?.includes('Correct native answer.')`);
  const result=await js(`({stt:window.jarvisNativeSmoke.stt,sends:window.jarvisNativeSmoke.sends,spoken:window.jarvisNativeSmoke.spoken,stops:window.jarvisNativeSmoke.microphoneStops})`);
  assert.deepEqual(result.stt,['provider']);
  assert.equal(result.sends.length,1);
  assert.equal(result.sends[0].sessionId,'composer-preview');
  assert.deepEqual(result.spoken,['Correct native answer.']);
  assert.ok(result.stops>=1);
  assert.deepEqual(errors,[]);
  console.log('PASS Electron synthetic native ChatGPT: Settings > consent > provider STT > native bridge outbox > exact-turn TTS; no physical mic or account.');
  win.destroy();await server.close();fs.rmSync(temp,{recursive:true,force:true});app.exit(0);
}).catch(async error=>{console.error(error);if(win&&!win.isDestroyed())win.destroy();await server?.close();fs.rmSync(temp,{recursive:true,force:true});app.exit(1);});
