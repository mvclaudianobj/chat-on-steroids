// Static production UI fixture: synthetic hosts only, scripts and credentials are never loaded.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs/feature-notes/screenshots/remote-hosts-after.png');
const runtime = path.join(root, '.tmp', 'remote-hosts-ui-fixture');
app.setPath('userData', runtime);
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['file://*/*'] }, (details, reply) => reply({ cancel: details.resourceType === 'script' }));
  const html = fs.readFileSync(path.join(root, 'out/renderer/index.html'), 'utf8')
    .replace('<head>', `<head><base href="${pathToFileURL(path.join(root, 'out/renderer/')).href}">`);
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'fixture.html'), html);
  const win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { sandbox: true, backgroundThrottling: false } });
  try {
    await win.loadFile(path.join(runtime, 'fixture.html'));
    const facts = await win.webContents.executeJavaScript(`(() => {
      document.documentElement.dataset.theme = 'light';
      const app = document.querySelector('.app'); app.dataset.screen = 'settings';
      for (const panel of document.querySelectorAll('.panel')) panel.classList.toggle('is-active', panel.dataset.panel === 'remote-hosts');
      const page = document.getElementById('remoteHosts');
      const list = page.querySelector('#remoteRows');
      const setting = document.createElement('div'); setting.className = 'setting';
      const name = document.createElement('span'); name.className = 'setting-text';
      name.textContent = 'Laboratory · SSH · tester@server.example:2222'; setting.append(name);
      for (const title of ['Test connection','Trust host fingerprint','Install master key on this host','Open as project','Open terminal on this host']) {
        const button = document.createElement('button'); button.className = 'btn'; button.textContent = title; setting.append(button);
      }
      list.append(setting);
      page.querySelector('#remoteName').value='Laboratory';
      page.querySelector('#remoteAddress').value='server.example';
      page.querySelector('#remotePort').value='2222';
      page.querySelector('#remoteUser').value='tester';
      page.querySelector('#remoteFolder').value='/srv/laboratory';
      page.querySelector('#remotePassword').value='';
      page.scrollIntoView({block:'start'});
      return {title:document.getElementById('remoteHostsTitle').textContent, passwordEmpty:!page.querySelector('#remotePassword').value,
        row:setting.textContent, overflow:page.scrollWidth > page.clientWidth + 4};
    })()`);
    assert.equal(facts.title, 'Remote hosts');
    assert.equal(facts.passwordEmpty, true);
    assert.match(facts.row, /Laboratory.*SSH/);
    assert.equal(facts.overflow, false);
    await new Promise(resolve => setTimeout(resolve, 350));
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, (await win.webContents.capturePage()).toPNG());
    console.log('PASS remote hosts synthetic UI, no password visible and no horizontal overflow');
  } finally { win.destroy(); app.exit(0); }
}).catch(error => { console.error(error); app.exit(1); });
