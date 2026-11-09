# Jarvis P0 — incremental voice playback on the O4 base

The J3 voice provider, consented microphone capture, opt-in continuous listening, 12-locales UI,
sentence extraction and barge-in are incorporated into the O4 `1f67bcfe` foundation. J3's
original voice path waited for the provider's **entire audio response per sentence** before
creating a playback Blob. This P0 increment adds authenticated main-to-renderer chunk delivery:

1. Main begins `/v1/audio/speech` for the first complete sentence while the answer text is still
   streaming, and forwards bounded chunks as `jarvis:speech-stream` for a UUID request ID.
2. The renderer attaches one MediaSource player per request. For MIME types supported by the
   installed Chromium, it appends chunks in order and starts playback before the HTTP response
   completes. The next sentence is already prefetched through the J3 queue.
3. If Chromium's MediaSource cannot handle that audio MIME, the renderer buffers the bounded
   sentence to a Blob and plays it when complete. This is a **per-sentence fallback**, not
   progressive byte playback; some providers also buffer generation server-side.
4. Every PTT interruption aborts old HTTP requests, silences the audio element, invalidates
   queued speech and drops late chunks by request ID. The provider response is bounded to 16 MB.

The main log records first HTTP audio byte, synthesis completion, and byte count. The renderer
reports the first audible playback event in milliseconds. These measure **different boundaries**:
the first network chunk does not imply successful decoding or audible sound on speakers.

Synthetic validation on Linux: 34 focused Vitest cases in five files, including fake HTTP
chunks delivered before response completion, cancellation, stream order, MediaSource early
playback, fallback and old-turn rejection. `npm run build` and isolated Electron
`verify-jarvis-ui.cjs` with synthetic fixture passed. `npm run verify:privacy` passed.
The global typecheck is blocked by missing shared production dependencies `qrcode` and
`@whiskeysockets/baileys` in this workspace; notices verification is blocked by missing
`@borewit/text-codec`. No dependencies were installed. Native Windows/WSL, provider latency
with a real configured account, acoustic playback, real microphone, and CPU/audio continuity
under hardware load require separately authorized manual homologation.

Configuration remains local, and provider credentials remain in Vault K. No microphone data,
production sessions or actual provider credentials were accessed. The Linux fixture did not
attempt real CLIProxy, speech synthesis or an audio output device.
