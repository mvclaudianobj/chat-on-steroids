/**
 * The server half of a WebSocket over a pair of byte streams, as codex-cli 0.163 serves its
 * app-server socket (the `proxy` child only relays bytes): reads the HTTP upgrade, answers 101
 * with Codex's frame-limit header and hands the stream to `ws`. For the Codex engine fixtures.
 */
'use strict';
const { WebSocketServer } = require('ws');

const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/** Resolves with the server-side WebSocket once the client's upgrade request arrived. */
function acceptWebSocket(stream, options = {}) {
  const maxPayload = options.maxPayload ?? MAX_MESSAGE_BYTES;
  // `ws` tunes the socket it gets; a pipe has nothing to tune.
  stream.setTimeout = stream.setNoDelay = stream.setKeepAlive = () => stream;
  const server = new WebSocketServer({ noServer: true, maxPayload, perMessageDeflate: false });
  server.on('headers', headers => headers.push(`x-codex-websocket-max-unfragmented-message-bytes: ${maxPayload}`));
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      stream.off('data', onData);
      const [requestLine, ...lines] = buffered.subarray(0, end).toString('latin1').split('\r\n');
      const headers = {};
      for (const line of lines) {
        const colon = line.indexOf(':');
        if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      const [method, url] = requestLine.split(' ');
      // Synchronous: `ws` takes over the stream's 'data' before the next chunk is emitted.
      server.handleUpgrade({ method, url, headers, socket: stream }, stream, buffered.subarray(end + 4), resolve);
    };
    stream.on('data', onData);
    stream.once('end', () => reject(new Error('closed before the upgrade')));
  });
}

module.exports = { acceptWebSocket, MAX_MESSAGE_BYTES };
