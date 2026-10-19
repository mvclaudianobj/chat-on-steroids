// Test process only: exercise the real login gate with a synthetic server identity.
// Never import this fixture from production main, preload, or renderer code.
const assert = require('node:assert/strict');
const path = require('node:path');

// The native BrowserWindow title is not reliable at creation on every desktop OS.
// The login preload is the stable identity specified by the production login gate.
function isPetMarkspanelLoginWindow(window) {
  const preload = window.webContents.getLastWebPreferences?.()?.preload;
  return typeof preload === 'string' && preload.length > 0 ? path.basename(preload) === 'markspanel-login.js'
    : window.getTitle().includes('Entrar');
}

function isPetMarkspanelLoginDocument(url) {
  try {
    const page = new URL(url);
    return ['file:', 'http:', 'https:'].includes(page.protocol) && page.pathname.endsWith('/markspanel-login.html');
  } catch { return false; }
}

function installPetMarkspanelLogin({ app, BrowserWindow, safeStorage }) {
  const originalFetch = global.fetch;
  const originalAvailable = safeStorage.isAsyncEncryptionAvailable;
  const originalEncrypt = safeStorage.encryptStringAsync;
  const originalDecrypt = safeStorage.decryptStringAsync;
  let loaded = false;
  let filled = false;
  let loginRequested = false;
  let profileValidated = false;
  let loginClosed = false;
  let verified = false;
  process.on('exit', code => {
    if (code === 0 && !verified) {
      console.error('Pet GUI probe exited without completing its login and overlay assertions');
      process.exitCode = 1;
    }
  });
  safeStorage.isAsyncEncryptionAvailable = async () => true;
  safeStorage.encryptStringAsync = async value => Buffer.concat([Buffer.from('v11'), Buffer.from(value, 'utf8')]);
  safeStorage.decryptStringAsync = async value => ({ result: value.subarray(3).toString('utf8'), shouldReEncrypt: false });
  global.fetch = async (url, options = {}) => {
    const endpoint = String(url);
    if (endpoint === 'https://marks.ia.br/auth/device/login') {
      assert.equal(JSON.parse(options.body).email, 'pet-probe@example.invalid');
      assert.equal(JSON.parse(options.body).password, 'pet-probe-password');
      loginRequested = true;
      return new Response(JSON.stringify({ access_token: 'pet-probe-access', refresh_token: 'pet-probe-refresh', token_type: 'Bearer', expires_in: 3600 }), { status: 200 });
    }
    if (endpoint === 'https://marks.ia.br/api/user') {
      assert.equal(options.headers.authorization, 'Bearer pet-probe-access');
      assert.equal(loginRequested, true, 'The profile check must follow the password login');
      profileValidated = true;
      return new Response(JSON.stringify({ id: 'pet-probe-user', email: 'pet-probe@example.invalid' }), { status: 200 });
    }
    if (endpoint.startsWith('https://marks.ia.br/')) throw new Error(`Unexpected MarksPanel request: ${endpoint}`);
    return originalFetch(url, options);
  };
  app.once('before-quit', () => {
    global.fetch = originalFetch;
    safeStorage.isAsyncEncryptionAvailable = originalAvailable;
    safeStorage.encryptStringAsync = originalEncrypt;
    safeStorage.decryptStringAsync = originalDecrypt;
  });
  app.on('browser-window-created', (_event, window) => {
    console.log('Pet login window candidate:', { title: window.getTitle(), preload: path.basename(window.webContents.getLastWebPreferences?.()?.preload ?? '') });
    if (!isPetMarkspanelLoginWindow(window)) return;
    window.once('closed', () => { loginClosed = true; });
    window.webContents.on('did-finish-load', () => {
      console.log('Pet login load:', { document: window.webContents.getURL().split('/').pop() });
      // On fast native hosts the first did-finish-load can be for about:blank.
      // Wait for the actual, verified login document before interacting with it.
      if (loaded || !isPetMarkspanelLoginDocument(window.webContents.getURL())) return;
      loaded = true;
      void window.webContents.executeJavaScript(`(() => {
        const email = document.getElementById('email');
        const password = document.getElementById('password');
        const form = document.getElementById('passwordForm');
        if (!email || !password || !form || !window.markspanelAuth?.password) {
          throw new Error('MarksPanel login form or its preload is unavailable');
        }
        email.value = 'pet-probe@example.invalid';
        password.value = 'pet-probe-password';
        return true;
      })()`).then(() => {
        filled = true;
        // The real success path closes this renderer during the password IPC.
        // Verify input injection first; then judge the submit by the authenticated
        // server requests, the approved window close and all later GUI assertions.
        // An executeJavaScript reply lost to window teardown is not a login failure.
        void window.webContents.executeJavaScript(`document.getElementById('passwordForm').requestSubmit(); true`)
          .catch(error => {
            // If submission failed before reaching the auth handler, the deadline
            // and final proof will fail. Keep this diagnostic for that case.
            if (!loginRequested) console.error('Pet login submit execution failed:', error);
          });
      }).catch(error => {
        console.error('Pet login form/preload verification failed:', error);
        app.exit(1);
      });
    });
  });
  return () => {
    assert.equal(loaded, true, 'The real MarksPanel login document must load');
    assert.equal(filled, true, 'The real login form and protected preload must be usable');
    assert.equal(loginRequested, true, 'The form must invoke the real password handler');
    assert.equal(profileValidated, true, 'The real handler must validate the authenticated profile');
    assert.equal(loginClosed, true, 'The approved login must close its window');
    verified = true;
  };
}

module.exports = { installPetMarkspanelLogin, isPetMarkspanelLoginWindow, isPetMarkspanelLoginDocument };
