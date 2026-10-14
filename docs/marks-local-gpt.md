# Chat Marks Local GPT

This fork tracks the official Chat On Steroids v2.1.36 tag (`816b5993`) and uses
**Chat Marks Local GPT** for its app, connectors, extension and installation labels.

The bridge protocol, app ID, internal package name and persistent data locations
retain their upstream identifiers to preserve compatibility with existing settings
and connector installations. Third-party license, authorship and upstream source
references remain attributed to their owners.

The customized updater targets `mvclaudianobj/chat-on-steroids` and the fork's
`Chat-Marks-Local-GPT-*` release assets. A fork release must publish matching
artifacts and checksums before automatic updates can be applied.

Validation on 2026-10-14: `npm run typecheck` and `npm run build` passed;
the targeted update, connector-name and main-text tests passed (50 tests).
The wider extension/content script test run had one failure in 904 content tests;
this is not claimed as a complete clean suite or live-installed verification.
