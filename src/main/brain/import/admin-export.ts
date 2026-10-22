/**
 * Chat Marks Brain H2: "Export from administrator account".
 *
 * ONE `pkexec /bin/sh -c <constant script> chat-marks-brain-export <uuid>` (the CLIProxy
 * installer precedent). The script reads only the fixed source paths below, opens every original
 * database read-only (`sqlite3 -readonly` and `mode=ro&immutable=1`; a database whose WAL holds
 * data is first copied with its -wal/-shm and only the copy is opened), copies only conversation
 * tables, never `credential`/`account`/`kv`, checks free space first, records sha256/size/mtime
 * of each source before and after, and leaves a 0700 folder owned by the requesting account.
 * The script contains no single quote, so the same text can be pasted after `sudo /bin/sh -c '`.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { ADMIN_SOURCES, MEMORY_FILES, LEGACY_FOLDERS, type ImportSource } from './sources.js';

export const PKEXEC = '/usr/bin/pkexec';
export const SH = '/bin/sh';
export const EXPORT_NAME = 'chat-marks-brain-export';
const SAFE_PATH = /^\/[A-Za-z0-9_./-]+$/;

const PROLOGUE = [
  'set -eu',
  'umask 077',
  'PATH=/usr/sbin:/usr/bin:/sbin:/bin',
  'LC_ALL=C',
  'export PATH LC_ALL',
  'q=$(printf "\\047")',
  'fail() { echo "error: $*" >&2; exit 1; }',
  'sid_arg=${1:-}',
  'case "$sid_arg" in ""|*[!0-9a-f-]*) fail "invalid staging id" ;; esac',
  '[ "${#sid_arg}" -eq 36 ] || fail "invalid staging id"',
  'uid=${PKEXEC_UID:-${SUDO_UID:-}}',
  'case "$uid" in ""|*[!0-9]*) fail "the requesting account is unknown; run through pkexec or sudo" ;; esac',
  '[ "$uid" -ne 0 ] || fail "the requesting account must not be the administrator"',
  'entry=$(getent passwd "$uid") || fail "the requesting account is unknown"',
  'gid=$(printf "%s" "$entry" | cut -d: -f4)',
  'home=$(printf "%s" "$entry" | cut -d: -f6)',
  'for tool in sqlite3 sha256sum stat df cp find sort xargs chown du; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is not installed"; done'
];

const BODY = [
  '[ -d "$base" ] && [ ! -L "$base" ] || fail "the staging folder is missing"',
  '[ "$(stat -c %u "$base")" = "$uid" ] || fail "the staging folder belongs to another account"',
  'need=0',
  'for f in $sized; do if [ -f "$f" ]; then need=$((need + $(stat -c %s "$f"))); fi; done',
  'cd "$base"',
  'avail=$(df -Pk . | tail -n 1 | tr -s " " | cut -d " " -f 4)',
  'avail=$((avail * 1024))',
  '[ "$avail" -gt $((need * 2)) ] || fail "not enough free space: $((need * 2)) bytes needed, $avail available"',
  'mkdir -m 0700 "$sid_arg" || fail "this staging copy already exists"',
  'cd "$sid_arg"',
  'inside=1',
  'finish() { if [ "${inside:-0}" = 1 ]; then rm -rf .raw; chown -R "$uid:$gid" . 2>/dev/null || true; chmod -R u+rwX,go-rwx . 2>/dev/null || true; fi; }',
  'trap finish EXIT',
  'mkdir -m 0700 db memory legacy .raw',
  'entries=""',
  'add() { if [ -n "$entries" ]; then entries="$entries,$1"; else entries="$1"; fi; }',
  'meta() { if [ -f "$1" ]; then printf "{\\"sha256\\":\\"%s\\",\\"size\\":%s,\\"mtime\\":%s}" "$(sha256sum < "$1" | cut -d " " -f 1)" "$(stat -c %s "$1")" "$(stat -c %Y "$1")"; else printf null; fi; }',
  `legacymeta() { printf "{\\"sha256\\":\\"%s\\",\\"files\\":%s}" "$(cd "$1" && find ${LEGACY_FOLDERS.join(' ')} -type f -print0 2>/dev/null | sort -z | xargs -0 -r sha256sum | sha256sum | cut -d " " -f 1)" "$(cd "$1" && find ${LEGACY_FOLDERS.join(' ')} -type f 2>/dev/null | wc -l)"; }`,
  'missing() { add "{\\"id\\":\\"$1\\",\\"family\\":\\"$2\\",\\"kind\\":\\"$3\\",\\"path\\":\\"$4\\",\\"status\\":\\"missing\\"}"; }',
  'export_db() {',
  '  sid=$1; family=$2; src=$3',
  '  if [ ! -f "$src" ] || [ -L "$src" ]; then missing "$sid" "$family" opencode-db "$src"; return 0; fi',
  '  echo "progress copy $sid"',
  '  before="{\\"db\\":$(meta "$src"),\\"wal\\":$(meta "$src-wal")}"',
  '  out="db/$sid.sqlite"',
  '  if [ -s "$src-wal" ]; then',
  '    cp -- "$src" ".raw/$sid.db"; cp -- "$src-wal" ".raw/$sid.db-wal"',
  '    if [ -f "$src-shm" ]; then cp -- "$src-shm" ".raw/$sid.db-shm"; fi',
  '    uri="file:.raw/$sid.db"',
  '    tables=" $(sqlite3 "$uri" .tables | tr -s " \\n" "  ") "',
  '  else',
  '    uri="file:$src?mode=ro&immutable=1"',
  '    tables=" $(sqlite3 -readonly "$uri" .tables | tr -s " \\n" "  ") "',
  '  fi',
  '  has() { case "$tables" in *" $1 "*) return 0 ;; esac; return 1; }',
  '  sql="ATTACH ${q}${uri}${q} AS src;"',
  '  v2=0',
  '  if has session_v2 && has session_message; then v2=1; sql="$sql CREATE TABLE session_v2 AS SELECT * FROM src.session_v2; CREATE TABLE session_message AS SELECT * FROM src.session_message; CREATE INDEX session_message_idx ON session_message(session_id, seq);"; fi',
  '  if has project; then sql="$sql CREATE TABLE project AS SELECT * FROM src.project;"; fi',
  '  if has session && has message; then',
  '    filter=""; if [ "$v2" = 1 ]; then filter=" WHERE id NOT IN (SELECT id FROM src.session_v2)"; fi',
  '    sql="$sql CREATE TABLE session AS SELECT * FROM src.session$filter; CREATE TABLE message AS SELECT * FROM src.message WHERE session_id IN (SELECT id FROM main.session); CREATE INDEX message_idx ON message(session_id, time_created, id);"',
  '    if has part; then sql="$sql CREATE TABLE part AS SELECT * FROM src.part WHERE session_id IN (SELECT id FROM main.session); CREATE INDEX part_idx ON part(message_id, id);"; fi',
  '  fi',
  '  sql="$sql DETACH src;"',
  '  echo "progress filter $sid"',
  '  status=copied',
  '  if ! sqlite3 "$out" "$sql"; then rm -f "$out"; status=failed; fi',
  '  rm -f ".raw/$sid.db" ".raw/$sid.db-wal" ".raw/$sid.db-shm"',
  '  counts=""',
  '  if [ "$status" = copied ]; then',
  '    check=$(sqlite3 "$out" "PRAGMA quick_check" 2>/dev/null || echo failed)',
  '    [ "$check" = ok ] || status=damaged',
  '    for t in session_v2 session_message project session message part; do',
  '      if has "$t"; then n=$(sqlite3 "$out" "SELECT count(*) FROM $t" 2>/dev/null || echo 0); counts="$counts${counts:+,}\\"$t\\":$n"; fi',
  '    done',
  '  fi',
  '  echo "progress verify $sid"',
  '  after="{\\"db\\":$(meta "$src"),\\"wal\\":$(meta "$src-wal")}"',
  '  same=false; if [ "$before" = "$after" ]; then same=true; fi',
  '  size=0; if [ -f "$out" ]; then size=$(stat -c %s "$out"); fi',
  '  add "{\\"id\\":\\"$sid\\",\\"family\\":\\"$family\\",\\"kind\\":\\"opencode-db\\",\\"path\\":\\"$src\\",\\"status\\":\\"$status\\",\\"output\\":\\"$out\\",\\"before\\":$before,\\"after\\":$after,\\"unchanged\\":$same,\\"counts\\":{$counts},\\"bytes\\":$size}"',
  '}',
  'export_memory() {',
  '  sid=$1; dir=$2',
  `  for name in ${MEMORY_FILES.join(' ')}; do`,
  '    src="$dir/$name"',
  '    if [ -f "$src" ] && [ ! -L "$src" ]; then',
  '      before=$(meta "$src"); cp -- "$src" "memory/$name"; after=$(meta "$src")',
  '      same=false; if [ "$before" = "$after" ]; then same=true; fi',
  '      lines=$(wc -l < "memory/$name")',
  '      add "{\\"id\\":\\"$sid:$name\\",\\"family\\":\\"memory\\",\\"kind\\":\\"memory\\",\\"path\\":\\"$src\\",\\"status\\":\\"copied\\",\\"output\\":\\"memory/$name\\",\\"before\\":$before,\\"after\\":$after,\\"unchanged\\":$same,\\"counts\\":{\\"lines\\":$lines},\\"bytes\\":$(stat -c %s "memory/$name")}"',
  '    else missing "$sid:$name" memory memory "$src"; fi',
  '  done',
  '}',
  'export_legacy() {',
  '  sid=$1; family=$2; dir=$3',
  '  if [ ! -d "$dir" ] || [ -L "$dir" ]; then missing "$sid" "$family" legacy-json "$dir"; return 0; fi',
  '  echo "progress copy $sid"',
  '  before=$(legacymeta "$dir")',
  '  mkdir -m 0700 "legacy/$sid"',
  `  for sub in ${LEGACY_FOLDERS.join(' ')}; do if [ -d "$dir/$sub" ] && [ ! -L "$dir/$sub" ]; then cp -R -P -- "$dir/$sub" "legacy/$sid/$sub"; fi; done`,
  '  after=$(legacymeta "$dir")',
  '  same=false; if [ "$before" = "$after" ]; then same=true; fi',
  '  files=$(find "legacy/$sid" -type f | wc -l)',
  '  add "{\\"id\\":\\"$sid\\",\\"family\\":\\"$family\\",\\"kind\\":\\"legacy-json\\",\\"path\\":\\"$dir\\",\\"status\\":\\"copied\\",\\"output\\":\\"legacy/$sid\\",\\"before\\":$before,\\"after\\":$after,\\"unchanged\\":$same,\\"counts\\":{\\"files\\":$files},\\"bytes\\":$(du -sb "legacy/$sid" | cut -f 1)}"',
  '}'
];

const EPILOGUE = [
  'created=$(date +%s)',
  'printf "{\\"version\\":1,\\"kind\\":\\"admin\\",\\"id\\":\\"%s\\",\\"createdAt\\":%s000,\\"complete\\":true,\\"sources\\":[%s]}\\n" "$sid_arg" "$created" "$entries" > manifest.json',
  'rmdir .raw',
  'echo "export-complete $sid_arg"'
];

/**
 * Builds the script for a fixed source list. Production uses `ADMIN_EXPORT_SCRIPT` only; tests
 * build it for synthetic fixtures and another staging base. Paths are checked to be plain.
 */
export function adminExportScript(options: { sources: readonly ImportSource[]; base?: string }): string {
  for (const source of options.sources) if (!SAFE_PATH.test(source.path) || !/^[A-Za-z0-9_.-]+$/.test(source.id)) throw new Error('Unsafe export source');
  if (options.base !== undefined && !SAFE_PATH.test(options.base)) throw new Error('Unsafe staging base');
  const sized = options.sources.filter(source => source.kind === 'opencode-db').flatMap(source => [source.path, `${source.path}-wal`]);
  const calls = options.sources.map(source => source.kind === 'opencode-db' ? `export_db ${source.id} ${source.family} ${source.path}`
    : source.kind === 'memory' ? `export_memory ${source.id} ${source.path}`
    : source.kind === 'legacy-json' ? `export_legacy ${source.id} ${source.family} ${source.path}` : (() => { throw new Error('Unsupported admin source'); })());
  const script = [...PROLOGUE,
    `base=${options.base ?? '"$home/.local/state/chat-marks/brain-import/staging"'}`,
    `sized="${sized.join(' ')}"`,
    ...BODY, ...calls, ...EPILOGUE].join('\n');
  if (script.includes("'")) throw new Error('The export script must not contain single quotes');
  return script;
}

export const ADMIN_EXPORT_SCRIPT = adminExportScript({ sources: ADMIN_SOURCES });

/** The exact pkexec argument array: no shell assembly from data, the id is a validated UUID. */
export function adminExportCommand(stagingId: string, script = ADMIN_EXPORT_SCRIPT): [string, string[]] {
  if (!/^[0-9a-f-]{36}$/.test(stagingId)) throw new Error('invalid staging id');
  return [PKEXEC, [SH, '-c', script, EXPORT_NAME, stagingId]];
}

/** The same export for a root terminal (sudo sets SUDO_UID, which the script uses as the owner). */
export function manualExportCommand(stagingId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(stagingId)) throw new Error('invalid staging id');
  return `sudo /bin/sh -c '${ADMIN_EXPORT_SCRIPT}' ${EXPORT_NAME} ${stagingId}`;
}

export type ExportRunner = (command: string, args: string[], onLine: (line: string) => void) => Promise<{ code: number; stderr: string }>;
const spawnRunner: ExportRunner = (command, args, onLine) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let buffered = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffered += chunk;
    for (let index = buffered.indexOf('\n'); index >= 0; index = buffered.indexOf('\n')) { onLine(buffered.slice(0, index)); buffered = buffered.slice(index + 1); }
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-4000); });
  child.on('error', reject);
  child.on('close', code => resolve({ code: code ?? 1, stderr }));
});

/** Runs the one privileged export. Progress lines are `progress <phase> <source>`. */
export async function runAdminExport(stagingRoot: string, onProgress: (phase: string, source: string) => void, runner: ExportRunner = spawnRunner): Promise<{ stagingId: string }> {
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const stagingId = randomUUID();
  const [command, args] = adminExportCommand(stagingId);
  let completed = false;
  const result = await runner(command, args, line => {
    const match = /^progress (copy|filter|verify) ([A-Za-z0-9_.:-]+)$/.exec(line);
    if (match) onProgress(match[1]!, match[2]!);
    if (line === `export-complete ${stagingId}`) completed = true;
  });
  if (result.code === 126 || result.code === 127) throw new Error('Administrator export was cancelled');
  if (result.code !== 0 || !completed) {
    const reason = /error: ([^\n]{1,200})/.exec(result.stderr)?.[1];
    throw new Error(reason ? `Administrator export failed: ${reason}` : 'Administrator export failed');
  }
  return { stagingId };
}
