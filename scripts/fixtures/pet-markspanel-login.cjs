// Test process only: exercise the real login gate with a synthetic server identity.
// Never import this fixture from production main, preload, or renderer code.
const assert = require('node:assert/strict');

function installPetMarkspanelLogin({ app, BrowserWindow, safeStorage }) {
  const originalFetch = global.fetch;
  const originalAvailable = safeStorage.isAsyncEncryptionAvailable;
  const originalEncrypt = safeStorage.encryptStringAsync;
  const originalDecrypt = safeStorage.decryptStringAsync;
  let completed = false;
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
      return new Response(JSON.stringify({ access_token: 'pet-probe-access', refresh_token: 'pet-probe-refresh', token_type: 'Bearer', expires_in: 3600 }), { status: 200 });
    }
    if (endpoint === 'https://marks.ia.br/api/user') {
      assert.equal(options.headers.authorization, 'Bearer pet-probe-access');
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
    if (!window.getTitle().includes('Entrar')) return;
    window.webContents.once('did-finish-load', () => {
      void window.webContents.executeJavaScript(`(() => {
        document.getElementById('email').value = 'pet-probe@example.invalid';
        document.getElementById('password').value = 'pet-probe-password';
        document.getElementById('passwordForm').requestSubmit();
      })()`).then(() => { completed = true; }).catch(error => { console.error(error); app.exit(1); });
    });
  });
  return () => {
    assert.equal(completed, true, 'The probe must pass the actual MarksPanel login window');
    verified = true;
  };
}

module.exports = { installPetMarkspanelLogin };
