// Production renderer and real Chromium layout/input; synthetic data only.
// Chat Marks "New chat": with CLI modules enabled it opens one menu (ChatGPT first, then each module)
// and no separate "New <module>" buttons remain in the sidebar.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp', 'new-chat-menu'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
fs.rmSync(path.join(output, 'profile'), { recursive: true, force: true });
app.setPath('userData', path.join(output, 'profile')); app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let server, win;
const fixture = `(() => {
 const old=window.api,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
 const module=(id,name)=>({id,name,installed:true,enabled:true,running:true,supported:true,version:'1.0.0',detail:'ready'});
 // shared/appearance.ts defaultAppearance(): a complete appearance, so only the layout changes.
 const defaultLook={light:{background:'#f4f4f5',sidebar:'#e9edf2',accent:'#486f9d',contrast:45},dark:{background:'#181818',sidebar:'#1a2129',accent:'#b0cbed',contrast:60},font:'system',fontSize:14,translucentSidebar:true};
 let layout='projects';
 window.setLayout=async next=>{layout=next;const r=await methods.getState();composerFixture.emit('onStateChanged',r.data);};
 const methods={
  getState:async()=>{const r=await old.getState();r.data.config=fixtureMerge(fixtureDefaults,r.data.config);r.data.config.ui={...r.data.config.ui,language:'pt-BR',theme:'dark',appearance:{...(r.data.config.ui.appearance||defaultLook),sidebarLayout:layout}};return r;},
  cliStatus:()=>ok([module('markscode','MarksCode'),module('codex','Codex'),module('claude','Claude')]),
  cliSessions:()=>ok([])
 };
 window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:old[key]});
})();`;
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ configFile:false, root:path.join(root,'src/renderer'), cacheDir:path.join(output,'vite'), logLevel:'error',
    resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},
    server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},
    plugins:[{name:'new-chat-menu-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/timeline-fixture.js"></script></head>'),
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
  await until(`document.getElementById('newChat')?.getAttribute('aria-haspopup')==='menu'`);
  win.show(); win.focus(); win.webContents.focus(); await pause(100);
  assert.equal(await js(`document.querySelectorAll('#sidebarPrimary .cli-module-chat').length`),0,'No separate New <module> buttons');
  await capture('sidebar.png');
  await js(`document.getElementById('newChat').click()`);
  await until(`!!document.querySelector('.row-menu [data-row-action="new-chat-chatgpt"]')`);
  assert.deepEqual(await js(`[...document.querySelectorAll('.row-menu [data-row-action^="new-chat-"]')].map(b=>b.dataset.rowAction+'='+b.textContent.trim())`),
    ['new-chat-chatgpt=ChatGPT','new-chat-markscode=MarksCode','new-chat-codex=Codex','new-chat-claude=Claude']);
  await capture('menu.png');
  // The Inbox layout's compose button opens the same menu.
  await js(`document.querySelector('.row-menu')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await js(`window.setLayout('inbox')`);
  await until(`!!document.querySelector('[data-inbox-control="compose"]')`);
  await js(`document.querySelector('[data-inbox-control="compose"]').click()`);
  await until(`!!document.querySelector('.row-menu [data-row-action="new-chat-chatgpt"]')`);
  assert.deepEqual(await js(`[...document.querySelectorAll('.row-menu [data-row-action^="new-chat-"]')].map(b=>b.dataset.rowAction)`),
    ['new-chat-chatgpt','new-chat-markscode','new-chat-codex','new-chat-claude']);
  await capture('inbox-menu.png');
  assert.deepEqual(errors,[]);
  console.log('PASS: New chat opens one menu with ChatGPT first, then MarksCode, Codex and Claude, in the Projects and Inbox layouts');
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
