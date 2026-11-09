# WhatsApp QR: silent initial socket recovery on Debian -6

Base: `2a6a9a783c57e002a16a92911285e64c76669a14`; new independent worktree `qr-p0-deb6-20261023`. The QR TTL patch `ca7593d5` (original `3503329c`) and previous QR/SMTP work are already ancestors. They were not replayed.

## Reproduced defect

In the -6 code the initial 35,000 ms watchdog on an unpaired socket only assigned `{state:'error',reason:'qr_timeout'}`. The transport remained alive, with no timer for reconnection. The watchdog was not even installed for an authenticated (`creds.registered`) socket. When a WebSocket was silent and produced neither QR nor open/close, the UI was left in error or connecting forever with no automatic recovery.

Two new regression cases failed **before patch** on the exact -6 code using synthetic Baileys auth and fake WS (no network or account): new unpaired socket stayed open after 35.1 seconds (`close` calls 0 expected 1); registered session remained `{state:'connecting',stage:'network'}` after 35.1 seconds when an error/retry was expected. After patch, both pass.

## Functional correction

An initial socket watchdog is armed for **both** registered and unregistered sessions. At 35,000 ms without `connection:open` or QR: unregistered reports `qr_timeout/qr`, registered reports `connection_failed/network`, closes the socket and reuses bounded exponential backoff (first 3,000ms). The existing epoch and listener cleanup prevent an older callback from replacing a new socket; no authentication files are deleted or renamed. Existing 65/25-second QR rotation TTL remains intact. SMTP TLS/STARTTLS and no duplicate send behavior are unchanged.

## Evidence, scope and limitations

- Negative Vitest baseline: 2/2 failed in expected assertions, then 2/2 passed after fix. Full targeted integration **91/91**, eight suites, 14.07 seconds; includes WhatsApp/Telegram/SMTP, settings, rendering and IPC.
- Electron with sandboxed BrowserWindow, preload and main IPC, disposable profile and synthetic Baileys socket: **PASS**, first socket sends no QR, error `qr_timeout`, automatic 3-second retry creates second socket and QR PNG, **2 attempts / 1 close**. Positive QR rotation fixture also PASS.
- The previously extracted Debian **2.1.45.2-6** binary successfully loads packaged `qrcode`, `ws`, Baileys CJS, Baileys ESM and creates a fake-transport Baileys socket (PASS). This validates packaged module/bootstrap availability, while the corrected behavior is tested in real Electron against the revised source/IPC. No .deb rebuilt or installed.
- Typecheck, build, verify:notices (244 packages / 730 pinned sources), verify:privacy and diff check PASS. No actual WhatsApp scan, session, account, QR text, message, network transport or CEO data used. The production account's particular failure remains unverified.
