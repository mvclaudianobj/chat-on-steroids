// Isolated synthetic Company UI check and screenshots in real Electron Chromium.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.COS_UI_ROOT || path.resolve(__dirname, '..');
const output = path.resolve(process.env.COS_UI_OUTPUT || path.join(root, '.tmp/company-ui'));
const { fixtureConfigSource, BENIGN_RENDERER_ERRORS } = require(path.join(root, 'scripts/fixtures/app-defaults.cjs'));
fs.rmSync(path.join(output, 'profile'), { recursive:true, force:true });
app.setPath('userData', path.join(output, 'profile'));
app.disableHardwareAcceleration();
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
let server, win;
const fixture = `(() => {
  try { localStorage.setItem('cos.ui.language','en'); } catch {}
  const original=window.api,ok=data=>Promise.resolve({ok:true,data:structuredClone(data)});
  let company=null;
  const methods={
    markWhatsNewSeen:()=>ok(null),
    getState:async()=>{const reply=await original.getState();reply.data.config=fixtureMerge(fixtureDefaults,reply.data.config);reply.data.config.ui={...reply.data.config.ui,language:'en',theme:'dark'};return reply;},
    company:async request=>{
      if(request.action==='get')return ok(company??{version:1,company:{name:'Marks Studio',seatCount:5,roles:['marks-coo','marks-cto','marks-cio','marks-cpo','marks-cko','marks-cqo','marks-cco'],seats:['marks1','marks2','marks3','marks4','marks5']},requests:[],meetings:[],activities:[],demo:false});
      if(request.action==='demo'){
        const now=Date.now();
        const statuses=['inbox','assigned','working','review','needs-ceo','done'];
        const roles=['marks-coo','marks-cto','marks-cio','marks-cpo','marks-cko','marks-cqo','marks-cco'];
        const projects=['Design system','Website','Infrastructure','Platform','Research','Knowledge','Quality','Communication'];
        const titles=['Research user expectations','Build new homepage','Review service uptime','Prepare feature release','Approval for rollout','Summarize design notes','Check accessibility','Update stakeholder report'];
        const entries=['inbox','assigned','working','review','needs-ceo','done','working','review'];
        company={version:1,company:{name:'Marks Studio',seatCount:6,roles,seats:['marks1','marks2','marks3','marks4','marks5','marks6'],seatCount:6},demo:true,meetings:[{id:'00000000-0000-4000-8000-000000000101',title:'Leadership standup',participants:['ceo','marks-coo'],at:now,durationMinutes:20,minutes:'We reviewed priorities.',decisions:['Prepare the next review.'],brainSync:'pending'}],activities:[],requests:titles.map((title,i)=>({id:'00000000-0000-4000-8000-'+String(i+1).padStart(12,'0'),title,project:projects[i],origin:i%2===0?'ceo':'marks-coo',owner:roles[i%7],seat:entries[i]==='inbox'?null:'marks'+(i%5+1),engine:['codex','claude','chatgpt'][i%3],model:['gpt-6','sonnet','free'][i%3],acceptance:'Provide a reviewable result.',tokenBudget:12000,timeBudgetMinutes:120,tokensUsed:i*1324,minutesUsed:i*7,dueAt:now+(i-2)*86400000,status:entries[i],raci:{responsible:'marks-coo',accountable:'ceo',consulted:[],informed:[]},history:[{at:now,actor:'ceo',note:'Created'}],createdAt:now,updatedAt:now-i*12000}))};
        company.requests.find(r=>r.status==='done').execution={mode:'simulated',phase:'reported',ownerId:'00000000-0000-4000-8000-000000000301',runId:'00000000-0000-4000-8000-000000000302',workerId:'worker-5',reportId:'fixture-report-5',result:'Synthetic result',evidence:'fixture-proof',authorizedAt:now-100000};
        company.requests.find(r=>r.status==='done').cooConfirmation={actor:'marks-coo',at:now-1000,workerId:'worker-5',reportId:'fixture-report-5',evidence:'fixture-COO-acceptance'};
        company.activities=company.requests.map((r,i)=>({id:'00000000-0000-4000-8000-'+String(200+i).padStart(12,'0'),at:r.updatedAt,actor:r.owner,kind:'request',requestId:r.id,message:r.title+' · '+r.status}));return ok(company);
      }
      if(request.action==='move'){company.requests.find(r=>r.id===request.payload.id).status=request.payload.status;return ok(company);}
      return ok(company);
    }
  };window.api=new Proxy(methods,{get:(target,key)=>key in target?target[key]:original[key]});
})();`;
app.whenReady().then(async()=>{
  const {createServer}=await import('vite');
  server=await createServer({configFile:false,root:path.join(root,'src/renderer'),cacheDir:path.join(output,'vite'),logLevel:'error',resolve:{alias:{'@phosphor-icons/web':path.join(root,'node_modules/@phosphor-icons/web/src')}},server:{host:'127.0.0.1',port:0,fs:{allow:[root,fs.realpathSync(path.join(root,'node_modules/@phosphor-icons/web/src'))]}},plugins:[{name:'company-ui-fixture',transformIndexHtml:html=>html.replace('</head>','<script src="/company-fixture.js"></script></head>'),configureServer(vite){vite.middlewares.use((req,res,next)=>{if(req.url!=='/company-fixture.js')return next();res.setHeader('Content-Type','text/javascript');res.end(fixtureConfigSource()+fs.readFileSync(path.join(root,'scripts/fixtures/composer-ui.js'),'utf8')+fixture);});}}]});
  await server.listen();
  win=new BrowserWindow({show:false,width:1700,height:1050,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[]; win.webContents.on('console-message',e=>{if(e.level==='error'&&!BENIGN_RENDERER_ERRORS.includes(e.message))errors.push(e.message);});
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async expression=>{for(const end=Date.now()+15000;Date.now()<end;){if(await js(expression))return;await pause(75);}throw new Error('Timeout: '+expression);};
  const screenshot=async name=>{fs.mkdirSync(output,{recursive:true});await pause(250);fs.writeFileSync(path.join(output,name),(await win.webContents.capturePage()).toPNG());};
  await win.loadURL(server.resolvedUrls.local[0]); await until("!!document.getElementById('sidebarCompany')");
  win.show();win.focus();win.webContents.focus();
  await js("document.getElementById('sidebarCompany').click()");
  await until("!document.getElementById('companyEmpty').hidden");
  await js("document.getElementById('companyLoadDemo').click()");
  await until("document.querySelectorAll('.company-ticket').length===8");
  assert.equal(await js("document.querySelectorAll('.company-column').length"),6);
  assert.equal(await js("document.querySelectorAll('.company-ticket').length"),8);
  await screenshot('company-board-dark.png');
  await js("document.getElementById('companyOfficeTab').click()");
  await until("!document.getElementById('companyOffice').hidden");
  assert.equal(await js("document.querySelectorAll('.company-room').length"),9);
  assert.deepEqual(await js("[...document.querySelectorAll('.company-rest-worker')].map(node=>[node.dataset.seat,node.dataset.restKind])"),[['marks1','rest-confirmed'],['marks6','rest-free']]);
  assert.equal(await js("document.getElementById('companyRestRoom').getAttribute('role')"),'region');
  assert.equal(await js("document.querySelectorAll('.company-meeting').length"),1);
  await js("document.querySelector('.company-meeting button').click()");
  assert.equal(await js("document.getElementById('companyDialog').open"),true);
  assert.ok((await js("document.getElementById('companyDialogContent').textContent")).includes('Leadership standup'));
  assert.equal(await js("document.getElementById('companyDialogContent').textContent.includes('present ·')"),false);
  await js("document.getElementById('companyClose').click()");
  await screenshot('company-rest-dark.png');
  await screenshot('company-office-dark.png');
  await js("document.documentElement.dataset.theme='light'; const sheet=document.createElement('style');sheet.id='company-fixture-light';sheet.textContent=':root, :root[data-theme=dark] {--page:#f4f4f5!important;--card:#ffffff!important;--ink:#0c0c0e!important;--soft:#56565e!important;--line:#e7e7ea!important;--sunk:#f7f7f8!important;--accent:#486f9d!important;--red:#b4262c!important;}';document.head.append(sheet)");
  await screenshot('company-office-light.png');
  await screenshot('company-rest-light.png');
  await js("document.getElementById('companyRpgTab').click()");
  await until("!document.getElementById('companyRpg').hidden");
  assert.equal(await js("document.querySelectorAll('.company-rpg-room').length"),5);
  assert.equal(await js("document.querySelectorAll('.company-rpg-actor').length"),6);
  assert.equal(await js("document.querySelectorAll('.company-rpg-meeting .company-rpg-actor').length"),0);
  assert.equal(await js("document.querySelectorAll('.company-rpg-rest .company-rpg-actor').length"),0);
  await screenshot('company-rpg-light.png');
  await js("document.getElementById('companyOfficeTab').click()");
  assert.equal(await js("document.getElementById('companyOffice').hidden"),false);
  await js("document.getElementById('companyRpgTab').click()");
  assert.equal(await js("localStorage.getItem('company:view')"),'rpg');
  // Capture the RPG itself in the dark theme; the previous sequence saved the
  // light Board under the RPG-dark filename, hiding a visual regression.
  await js("window.companyFixtureLight=document.getElementById('company-fixture-light');window.companyFixtureLight.remove();document.documentElement.dataset.theme='dark'");
  await until("!document.getElementById('companyRpg').hidden && document.documentElement.dataset.theme==='dark'");
  await screenshot('company-rpg-dark.png');
  await js("document.documentElement.dataset.theme='light';document.head.append(window.companyFixtureLight);document.getElementById('companyBoardTab').click()");
  await until("!document.getElementById('companyBoard').hidden");
  await screenshot('company-board-light.png');
  await js("document.querySelector('.company-ticket').click()");
  assert.equal(await js("document.getElementById('companyDialog').open"),true);
  assert.ok((await js("document.getElementById('companyDialogContent').textContent")).includes('Acceptance criteria'));
  assert.deepEqual(errors,[]);
  console.log('PASS: Company synthetic board, office, rest room, meeting details, both themes, request dialog. Screenshots: '+output);
  win.destroy();await server.close();app.exit(0);
}).catch(async error=>{fs.mkdirSync(output,{recursive:true});if(win&&!win.isDestroyed())fs.writeFileSync(path.join(output,'company-error.png'),(await win.webContents.capturePage()).toPNG());console.error(error);await server?.close();app.exit(1);});
