/**
 * Chat Marks portable vault v1. Only this main-process module handles plaintext.
 * AES-256-GCM encrypts the entire catalog; its random data key has two independent
 * recovery routes: OS safeStorage (secrets.bin) and a scrypt-derived master-password wrap.
 * Neither an imported GPG passphrase nor the master password is persisted or logged.
 */
import { randomBytes, randomUUID, createCipheriv, createDecipheriv, scrypt as scryptCallback } from 'node:crypto';
import { constants } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getSecret, setSecret } from './secrets.js';
import { replaceVaultRedactionEntries } from './marks-vault-redaction.js';

const SLOT = 'marks:vaultKey';
const MAX_FILE = 3 * 1024 * 1024;
const MAX_ENTRIES = 1000;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,79}$/;
const VERSION = 1;
const KDF = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const PREFIX = 'Chat Marks vault v1:';

/**
 * `insecureHttp` (Chat Marks H1b) is the only way an entry may name a plain `http:` origin. It is an
 * explicit administrator acknowledgement; model-facing `vault_use` still refuses such entries.
 */
export interface VaultEntry { name: string; value: string; origin: string; header: string; insecureHttp?: boolean }
export type VaultItem = Omit<VaultEntry, 'value'>;
interface Sealed { iv: string; tag: string; data: string }
interface VaultFile { format: 'chat-marks-vault'; version: 1; id: string; salt: string; wrapped: Sealed; records: Sealed }
interface VaultCatalog { entries: VaultEntry[] }
interface LocalKey { id: string; key: string }
export interface VaultDependencies {
  getKey(): Promise<string | null>;
  setKey(value: string): Promise<void>;
}
const normalDeps: VaultDependencies = { getKey: () => getSecret(SLOT), setKey: value => setSecret(SLOT, value) };
let vaultFile = '';
let deps: VaultDependencies = normalDeps;
let queue: Promise<void> = Promise.resolve();

export function initMarksVault(userData: string): void { vaultFile = path.join(userData, 'marks-vault.json'); }
/** Test-only dependency and path isolation; not exposed to the renderer. */
export function configureVaultForTests(file: string, alternate: VaultDependencies | null): void {
  vaultFile = file; deps = alternate ?? normalDeps; queue = Promise.resolve();
}
function serialize<T>(op: () => Promise<T>): Promise<T> {
  const result = queue.then(op);
  queue = result.then(() => undefined, () => undefined);
  return result;
}
function encoded(buffer: Buffer): string { return buffer.toString('base64'); }
function decode(value: string): Buffer {
  if (typeof value !== 'string' || !/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid vault encoding');
  return Buffer.from(value, 'base64');
}
function seal(key: Buffer, value: Buffer, aad: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const data = Buffer.concat([cipher.update(value), cipher.final()]);
  return { iv: encoded(iv), tag: encoded(cipher.getAuthTag()), data: encoded(data) };
}
function unseal(key: Buffer, sealed: Sealed, aad: string): Buffer {
  const iv = decode(sealed.iv), tag = decode(sealed.tag), data = decode(sealed.data);
  if (iv.length !== 12 || tag.length !== 16 || data.length > MAX_FILE) throw new Error('Invalid vault envelope');
  const cipher = createDecipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
function validateEntry(candidate: unknown): VaultEntry {
  if (!candidate || typeof candidate !== 'object') throw new Error('Invalid vault entry');
  const entry = candidate as Record<string, unknown>;
  if (typeof entry.name !== 'string' || !NAME.test(entry.name) ||
      typeof entry.value !== 'string' || !entry.value || entry.value.length > 16384 ||
      typeof entry.origin !== 'string' || entry.origin.length > 300 ||
      typeof entry.header !== 'string' || !/^[a-zA-Z][a-zA-Z0-9-]{0,79}$/.test(entry.header)) throw new Error('Invalid vault entry');
  if (entry.origin) {
    let url: URL;
    try { url = new URL(entry.origin); } catch { throw new Error('Invalid secret origin'); }
    const plainAllowed = url.protocol === 'http:' && entry.insecureHttp === true;
    if (entry.insecureHttp !== undefined && typeof entry.insecureHttp !== 'boolean') throw new Error('Invalid vault entry');
    if ((url.protocol !== 'https:' && !plainAllowed) || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== entry.origin) {
      throw new Error('Secret origin must be exact HTTPS (or HTTP with an explicit insecure acknowledgement)');
    }
  }
  const insecure = entry.insecureHttp === true && entry.origin.startsWith('http:');
  return { name: entry.name, value: entry.value, origin: entry.origin, header: entry.header, ...(insecure ? { insecureHttp: true } : {}) };
}
function catalogFrom(value: Buffer): VaultCatalog {
  const parsed: unknown = JSON.parse(value.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as VaultCatalog).entries)) throw new Error('Invalid vault catalog');
  const entries = (parsed as VaultCatalog).entries;
  if (entries.length > MAX_ENTRIES) throw new Error('Vault capacity exceeded');
  const validated = entries.map(validateEntry);
  if (new Set(validated.map(entry => entry.name)).size !== validated.length) throw new Error('Duplicate vault names');
  replaceVaultRedactionEntries(validated);
  return { entries: validated };
}
function validateFile(value: unknown): VaultFile {
  const file = value as VaultFile;
  if (!file || file.format !== 'chat-marks-vault' || file.version !== VERSION ||
    !/^[a-f0-9-]{36}$/.test(file.id) || typeof file.salt !== 'string' || decode(file.salt).length !== 16 ||
    !file.wrapped || !file.records || typeof file.wrapped.iv !== 'string' || typeof file.records.iv !== 'string') {
    throw new Error('Unrecognized vault format');
  }
  return file;
}
async function readVault(): Promise<VaultFile | null> {
  if (!vaultFile) throw new Error('Vault not initialized');
  let file: import('node:fs/promises').FileHandle;
  try { file = await fs.open(vaultFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Cannot open protected vault'); }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Invalid vault file');
    return validateFile(JSON.parse((await file.readFile('utf8'))));
  } finally { await file.close(); }
}
async function persist(file: VaultFile): Promise<void> {
  const output = Buffer.from(JSON.stringify(file) + '\n');
  if (output.length > MAX_FILE) throw new Error('Vault is too large');
  const parent = path.dirname(vaultFile);
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const temp = `${vaultFile}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, output, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, vaultFile);
    await fs.chmod(vaultFile, 0o600);
  } finally { await fs.rm(temp, { force: true }).catch(() => undefined); }
}
async function masterKey(password: string, salt: string): Promise<Buffer> {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw new Error('Master password must have at least 12 characters');
  return await new Promise<Buffer>((resolve, reject) => scryptCallback(password, decode(salt), 32, KDF, (error, key) => error ? reject(error) : resolve(key as Buffer)));
}
async function openKey(file: VaultFile, password?: string): Promise<Buffer> {
  if (password !== undefined) {
    const master = await masterKey(password, file.salt);
    try { return unseal(master, file.wrapped, `${PREFIX}${file.id}:master`); }
    catch { throw new Error('Invalid master password or damaged vault'); }
    finally { master.fill(0); }
  }
  const local = await deps.getKey();
  if (!local) throw new Error('Vault needs recovery with the master password');
  try {
    const parsed = JSON.parse(local) as LocalKey;
    if (parsed.id !== file.id || !/^[a-f0-9]{64}$/.test(parsed.key)) throw new Error('Wrong vault key');
    return Buffer.from(parsed.key, 'hex');
  } catch { throw new Error('Vault needs recovery with the master password'); }
}
async function readCatalog(file: VaultFile, key: Buffer): Promise<VaultCatalog> {
  try { return catalogFrom(unseal(key, file.records, `${PREFIX}${file.id}:records`)); }
  catch { throw new Error('Vault cannot be decrypted or is damaged'); }
}
async function withCatalog<T>(password: string | undefined, operation: (file: VaultFile, key: Buffer, data: VaultCatalog) => Promise<T>): Promise<T> {
  const file = await readVault();
  if (!file) throw new Error('Vault has not been created');
  const key = await openKey(file, password);
  try { return await operation(file, key, await readCatalog(file, key)); }
  finally { key.fill(0); }
}
async function update(file: VaultFile, key: Buffer, data: VaultCatalog): Promise<void> {
  file.records = seal(key, Buffer.from(JSON.stringify(data)), `${PREFIX}${file.id}:records`);
  await persist(file);
  replaceVaultRedactionEntries(data.entries);
}
export async function warmVaultRedaction(): Promise<void> {
  try { const file = await readVault(); if (!file) return; const key = await openKey(file); try { await readCatalog(file, key); } finally { key.fill(0); } }
  catch { replaceVaultRedactionEntries([]); }
}
export async function vaultStatus(): Promise<{ created: boolean; count: number | null; ready: boolean }> {
  const file = await readVault();
  if (!file) return { created: false, count: 0, ready: false };
  try {
    const key = await openKey(file);
    try { const data = await readCatalog(file, key); return { created: true, count: data.entries.length, ready: true }; }
    finally { key.fill(0); }
  } catch { return { created: true, count: null, ready: false }; }
}
export async function createVault(password: string): Promise<void> { return serialize(async () => {
  if (await readVault()) throw new Error('Vault already exists');
  const id = randomUUID(), key = randomBytes(32), salt = encoded(randomBytes(16));
  const master = await masterKey(password, salt);
  try {
    // Verify OS-backed secure storage before publishing a file that cannot be opened daily.
    await deps.setKey(JSON.stringify({ id, key: key.toString('hex') }));
    await persist({ format: 'chat-marks-vault', version: 1, id, salt,
      wrapped: seal(master, key, `${PREFIX}${id}:master`),
      records: seal(key, Buffer.from('{"entries":[]}'), `${PREFIX}${id}:records`) });
  } finally { master.fill(0); key.fill(0); }
}); }
export async function recoverVault(password: string): Promise<void> { return serialize(async () => {
  await withCatalog(password, async (file, key) => deps.setKey(JSON.stringify({ id: file.id, key: key.toString('hex') })));
}); }
export async function listVault(): Promise<VaultItem[]> { return serialize(() =>
  withCatalog(undefined, async (_file, _key, data) => data.entries.map(({ name, origin, header, insecureHttp }) => ({ name, origin, header, ...(insecureHttp ? { insecureHttp } : {}) })))); }
export async function putVault(entry: VaultEntry, password: string): Promise<void> { return serialize(async () => {
  const valid = validateEntry(entry);
  await withCatalog(password, async (file, key, data) => {
    const index = data.entries.findIndex(item => item.name === valid.name);
    if (index >= 0) data.entries[index] = valid; else data.entries.push(valid);
    if (data.entries.length > MAX_ENTRIES) throw new Error('Vault capacity exceeded');
    await update(file, key, data);
  });
}); }
export async function removeVault(name: string, password: string): Promise<void> { return serialize(async () => {
  await withCatalog(password, async (file, key, data) => {
    if (!NAME.test(name) || !data.entries.some(entry => entry.name === name)) throw new Error('Secret not found');
    data.entries = data.entries.filter(entry => entry.name !== name);
    await update(file, key, data);
  });
}); }
/** Administrative, explicit reveal only; the caller must enforce UI ownership. */
export async function revealVault(name: string, password: string): Promise<string> { return serialize(() =>
  withCatalog(password, async (_file, _key, data) => {
    const entry = data.entries.find(item => item.name === name);
    if (!entry) throw new Error('Secret not found');
    return entry.value;
  })); }
/** Ordinary operations never require or read the master password. */
export async function useVault(name: string, operation: (entry: VaultEntry) => Promise<string>): Promise<string> { return serialize(() =>
  withCatalog(undefined, async (_file, _key, data) => {
    const entry = data.entries.find(item => item.name === name);
    if (!entry) throw new Error('Secret not found');
    return operation(entry);
  })); }
export async function changeVaultPassword(oldPassword: string, newPassword: string): Promise<void> { return serialize(async () => {
  await withCatalog(oldPassword, async (file, key) => {
    const salt = encoded(randomBytes(16)), master = await masterKey(newPassword, salt);
    try { file.salt = salt; file.wrapped = seal(master, key, `${PREFIX}${file.id}:master`); await persist(file); }
    finally { master.fill(0); }
  });
}); }
/** Encrypted export is byte-for-byte portable; the OS wrap intentionally stays local. */
export async function exportVault(target: string, password: string): Promise<void> { return serialize(() =>
  withCatalog(password, async (file) => {
    const fd = await fs.open(target, 'wx', 0o600);
    try { await fd.writeFile(JSON.stringify(file) + '\n'); }
    finally { await fd.close(); }
  })); }
/** Import an encrypted Chat Marks vault from another computer, using its master password. */
export async function importVault(source: string, password: string): Promise<void> { return serialize(async () => {
  if (await readVault()) throw new Error('Export or back up the existing vault before importing');
  const stat = await fs.stat(source);
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Invalid import file');
  const file = validateFile(JSON.parse(await fs.readFile(source, 'utf8')));
  const key = await openKey(file, password);
  try {
    await readCatalog(file, key);
    await deps.setKey(JSON.stringify({ id: file.id, key: key.toString('hex') }));
    await persist(file);
  } finally { key.fill(0); }
}); }
/** Import cleartext already decrypted by the isolated GPG adapter, never exported to IPC. */
export async function importEntries(entries: VaultEntry[], password: string): Promise<number> { return serialize(async () => {
  if (entries.length > MAX_ENTRIES) throw new Error('Too many imported secrets');
  const validated = entries.map(validateEntry);
  if (new Set(validated.map(entry => entry.name)).size !== validated.length) throw new Error('Duplicate imported secret names');
  await withCatalog(password, async (file, key, data) => {
    for (const entry of validated) {
      const i = data.entries.findIndex(item => item.name === entry.name);
      if (i < 0) data.entries.push(entry); else data.entries[i] = entry;
    }
    if (data.entries.length > MAX_ENTRIES) throw new Error('Vault capacity exceeded');
    await update(file, key, data);
  });
  return validated.length;
}); }
