import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(process.cwd(), 'android');
const file = (name: string) => readFileSync(path.join(root, name), 'utf8');
describe('Android companion source security baseline', () => {
  it('declares a separate application id and disallows cleartext, backup and unrelated permissions', () => {
    const manifest = file('app/src/main/AndroidManifest.xml');
    const build = file('app/build.gradle');
    const network = file('app/src/main/res/xml/network_security_config.xml');
    expect(build).toContain("applicationId 'br.com.chatmarks.mobile'");
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest.match(/uses-permission/g)).toHaveLength(1);
    expect(manifest).toContain('android.permission.INTERNET');
    expect(network).toContain('cleartextTrafficPermitted="false"');
  });
  it('rejects TLS failures, arbitrary origins, JS native bridges and persisted tokens', () => {
    const source = file('app/src/main/java/br/com/chatmarks/mobile/MainActivity.java');
    expect(source).toContain('handler.cancel()');
    expect(source).toContain('MIXED_CONTENT_NEVER_ALLOW');
    expect(source).toContain('setAllowFileAccess(false)');
    expect(source).toContain('shouldInterceptRequest');
    expect(source).toContain('getRawUserInfo()');
    expect(source).not.toContain('addJavascriptInterface');
    expect(source).not.toContain('handler.proceed()');
    expect(source).not.toContain('setJavaScriptEnabled(false); // no-op');
    expect(source).not.toMatch(/putString\("token"/);
  });
});
