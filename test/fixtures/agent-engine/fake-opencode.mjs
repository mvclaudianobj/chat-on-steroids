#!/usr/bin/env node
// A stand-in for `opencode` 1.19.3 as Chat Marks starts it: `--version`, and `serve` printing the
// real listening line, answering /global/health behind HTTP Basic auth from the environment.
// It records its argv and environment where FAKE_OPENCODE_RECORD says, and exits on SIGTERM.
import http from 'node:http';
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(process.env.FAKE_OPENCODE_VERSION || '1.19.3'); process.exit(0); }
if (process.env.FAKE_OPENCODE_RECORD) writeFileSync(process.env.FAKE_OPENCODE_RECORD, JSON.stringify({ args, env: process.env, cwd: process.cwd() }));
if (args[0] !== 'serve') process.exit(2);
if (process.env.FAKE_OPENCODE_FAIL) { console.error(`boom ${process.env.OPENCODE_SERVER_PASSWORD}`); process.exit(3); }
const expected = `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_SERVER_PASSWORD}`).toString('base64')}`;
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== expected) { response.writeHead(401); response.end('Unauthorized'); return; }
  if (request.url === '/global/health') { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ healthy: true, version: process.env.FAKE_OPENCODE_VERSION || '1.19.3' })); return; }
  response.writeHead(404); response.end('{}');
});
server.listen(0, '127.0.0.1', () => console.log(`opencode server listening on http://127.0.0.1:${server.address().port}`));
process.on('SIGTERM', () => { server.close(); process.exit(0); });
