# Firefox VPN and TwinDesk (opt-in external modules)

Both applications are independently distributed under GPL-3.0. Chat Marks does **not** vendor, redistribute, embed or modify their executable or source, copy accounts, or take over their own interfaces. Modules > Firefox VPN / TwinDesk offers official installation/update links, conservative local executable detection, and an explicit **Open application** button.

## Firefox VPN

- Upstream: https://github.com/armanlife/firefox-vpn-client
- The Linux server core documents an optional local web panel at `http://127.0.0.1:10820/app/`. Chat Marks opens this address only after the user clicks; the VPN owns panel authentication. Nothing is sent to a remote panel or alternative host.
- No Firefox account import, background service control, traffic tunneling or system proxy/DNS change is performed by this module.
- In this first revision, status means **known CLI exists**, not a VPN connection, transport state or healthy network route.
- Upstream documents TCP/web-port restrictions, which may interfere with tools, SSH, notifications or real-time communication if its VPN is enabled manually.

## TwinDesk

- Upstream: https://github.com/InukaAsith/TwinDesk
- Launches a previously installed Linux desktop executable by one of three fixed local paths, after a confirmation in the renderer. Pairing, peers, screen-sharing, keyboard, clipboard and file permissions stay exclusively inside TwinDesk.
- This is **assisted graphical remote access** and is separate from Chat Marks' approved named SSH profiles. It does not let agents click or control remote machines, and is not a substitute for `remote_exec` approval.
- Installed status is conservative; neither installation nor launch proves any remote device is connected.

## Acceptance and security boundaries

- IPC allowlist admits only reviewed module ids and actions, rejects arbitrary management URLs on external modules and does not accept shell arguments, peer addresses or executable paths.
- Linux-only executable opening; other platforms receive official publisher instructions. No automatically installed `.deb`, AppImage or tarball, no service process restart, and no changes to local accounts or production sessions.
- An administrator should verify upstream artifacts and permissions before installing. Cross-platform executable detection, authenticated host/session integrations, live tunnel status, remote control and all real-network interoperability remain future work and must not be represented as completed.
- This is a separate feature branch, not a claim that WhatsApp host approvals or the 2.1.46.1 release are homologated.
