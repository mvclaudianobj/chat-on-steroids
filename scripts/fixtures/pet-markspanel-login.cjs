// Test process only: exercise the real login gate with a synthetic server identity.
// Never import this fixture from production main, preload, or renderer code.
const assert = require('node:assert/strict');

// Native titles and getLastWebPreferences() can both be empty at window creation
// on macOS. Only the loaded document proves which test window owns the page.
function petFixtureDocumentKind(url) {
  try {
    const page = new URL(url);
    if (page.protocol !== 'file:' && !(page.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(page.hostname))) return null;
    if (page.pathname.endsWith('/markspanel-login.html')) return 'login';
    if (page.pathname.endsWith('/pet-overlay.html')) return 'overlay';
    if (page.pathname.endsWith('/index.html')) return 'owner';
  } catch { /* Missing or transient navigation URL. */ }
  return null;
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
    window.webContents.on('did-finish-load', () => {
      // Avoid assigning the login to the ordinary owner while native metadata is
      // still unset. about:blank and other documents must not start login.
      if (loaded || petFixtureDocumentKind(window.webContents.getURL()) !== 'login') return;
      loaded = true;
      window.once('closed', () => { loginClosed = true; });
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
  const assertCompleted = () => {
    assert.equal(loaded, true, 'The real MarksPanel login document must load');
    assert.equal(filled, true, 'The real login form and protected preload must be usable');
    assert.equal(loginRequested, true, 'The form must invoke the real password handler');
    assert.equal(profileValidated, true, 'The real handler must validate the authenticated profile');
    assert.equal(loginClosed, true, 'The approved login must close its window');
    verified = true;
  };
  assertCompleted.status = () => ({ loaded, filled, loginRequested, profileValidated, loginClosed });
  return assertCompleted;
}

module.exports = { installPetMarkspanelLogin, petFixtureDocumentKind };
