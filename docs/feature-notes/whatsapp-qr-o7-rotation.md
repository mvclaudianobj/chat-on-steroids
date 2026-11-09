# WhatsApp Web QR: lifetime and recovery after a silent Baileys socket

This change is isolated on O7 homologation commit `2be2af72`. The O7 history already
contains the equivalent cherry-picks of the earlier QR diagnostics `fa3d14ef`
(`9252fefd`), status fix `a33a8b02`, and retry/auth reconciliation `71220095`
(`e4194b15`). SMTP failover `dc92752c` is retained as `f5cc97b5`.

## Reproduced failure

Baileys `7.0.0-rc14` generates the first pairing QR with a **60-second** lifetime
and subsequent rotating codes at **20-second** intervals
(`node_modules/@whiskeysockets/baileys/lib/Socket/socket.js`, `genPairQR`).
The earlier code cleared its only QR timeout as soon as the first QR arrived.
If Baileys subsequently stopped emitting updates without a `connection:close`
event, `getWhatsAppWebStatus` kept returning that old QR indefinitely. The
renderer regenerated a PNG from it and offered an invalid pairing code.

The regression was run **before the fix** with a socket fixture that emitted one
QR and then went silent. At simulated elapsed 65,100 ms the baseline returned
`state=qr` and still carried the old QR. Vitest failed:
`expected { state: 'qr', ... } to not have property 'qr'`.

## Functional correction

- A QR watchdog now tracks 65 seconds for the first QR and 25 seconds after each
  rotation, with small scheduling margins over Baileys' 60/20-second intervals.
- On silence after the validity deadline, the main process stops offering the
  stale QR, returns a sanitized `qr_timeout` at stage `qr`, closes the old socket,
  and schedules a new connection using the existing capped exponential backoff.
- Each genuine QR rotation resets the watchdog. Reconnection and explicit
  Disconnect clean up both timers and listeners. On `connection:close`, the old
  transport is closed before retrying, preventing a zombie socket.
- Existing paired authentication files remain unchanged. A timeout never
  clears session data. No pairing, messages or token access were involved.

## Effective negative and positive Electron cases

`scripts/verify-whatsapp-qr-runtime.cjs` uses an actual Electron main process,
isolated sandboxed window and preload, main IPC handler, QR PNG conversion and
a fake Baileys socket. Its profile is created under a disposable temporary
directory and removed on exit. Only the watchdog's 65/25-second timeouts are
accelerated in the fixture. It never connects to WhatsApp.

| Electron case | Expected result | Observed |
| --- | --- | --- |
| No QR from first socket | `qr_timeout`, no QR exposed; manual retry succeeds | PASS, 2 sockets, old socket closed once, ~1s fixture |
| Normal QR rotations | Replace first PNG without reconnecting | PASS, two rotations, 1 socket |
| Server silent after last rotation | Hide expired PNG; close socket and back off before retry | PASS, 2 total attempts, one close, retry >=3,000ms, ~4s fixture |

The same tests in Vitest cover expiration (including an initial failing baseline)
and timely rotations, in addition to existing timeout, retry and concurrency
tests. The Linux 2.1.45.2-5 `.deb` was only inspected: its `app.asar` matches
the extracted `linux-unpacked/resources/app.asar` at SHA-256
`6a946402370cc74b56b806566c81896530807f0a0f911abb71b4a4bd71cfcf99`.
The **extracted package** loads `qrcode`, `ws`, Baileys via CommonJS and dynamic
ESM and instantiates a Baileys socket with a fake transport (`exit 0`). The
existing packaged-runtime smoke also passed. The Electron fixture runs under
the installed local Electron dependency; passing a script to the packaged
application binary alone was not counted as an Electron fixture execution.

No real QR payload, WhatsApp account, authentication directory, proxy settings,
token or keyring was accessed. This proves a stale-QR functional defect and its
fix, **not** successful pairing of the CEO's WhatsApp session or the precise
cause of the reported production failure.
