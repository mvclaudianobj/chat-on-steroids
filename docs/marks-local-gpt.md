# Chat Marks Local GPT

This fork started at the official Chat On Steroids v2.1.36 tag (`816b5993`)
and has incorporated the 82 subsequent upstream commits through `cc41c538`.
Both points declare package version `2.1.36`. This fork uses
**Chat Marks Local GPT** for its app, connectors, extension and installation labels.

The bridge protocol, app ID, internal package name and persistent data locations
retain their upstream identifiers to preserve compatibility with existing settings
and connector installations. Third-party license, authorship and upstream source
references remain attributed to their owners.

The customized updater targets `mvclaudianobj/chat-on-steroids` and the fork's
`Chat-Marks-Local-GPT-*` release assets. A fork release must publish matching
artifacts and checksums before automatic updates can be applied.

Validation on 2026-10-14 after merging the later upstream fixes: `npm run
typecheck` and `npm run build` passed. Seven targeted suites passed (131 tests),
covering updates, connector names, localized main text, plugin refresh,
notifications and keep-awake behavior.
The wider extension/content script test run had one failure in 904 content tests;
this is not claimed as a complete clean suite or live-installed verification.
