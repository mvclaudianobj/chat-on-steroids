# Chat Marks — next version draft (not published)

## Scope

- MarksPanel gate: email/password and device-code login, OS-encrypted session, server
  validation and refresh, monitoring for revocation/network failure, explicit local logout.
- Four optional modules: MarksCode, Codex, Claude and MarksClaw with separate activation,
  discovery/version reporting, user-initiated package or source installation/update,
  stop controls and sidebar entries.
- Persistent, workspace-scoped terminals using tmux on Linux/macOS and WSL tmux on Windows.
- Headless message/response adapters for MarksCode, Codex and Claude in a dedicated chat
  view with separate local history, explicit backend sessions, streamed assistant answers,
  cancellation and workspace routing. Native ChatGPT conversations keep their existing
  message history and transport, independent of the CLI transcripts.

## Release conditions

1. Validate login and logout with an authorized MarksPanel test account without exposing
   credentials to logs, commits, attachments or test fixtures.
2. Test a real Windows installation with WSL enabled and disabled, macOS tmux, Linux tmux,
   authenticated CLI launch, session reconnect after process/window restart and workspace move.
3. Exercise each official CLI installer against its current publisher release and verify
   the installed binary's exact version and environment, including WSL builds.
   Run an authenticated full conversation and resume on each of the three headless chat CLIs.
4. Run full typecheck/build/test/privacy/notice checks and packaged-runtime smoke for each
   supported release target; collect native GUI evidence where possible.
5. Select and review the next version number, synchronize package/manifest/version sources,
   produce all release assets and obtain explicit approval before creating a tag/release.

The historical Windows releases v2.1.39.1 and v2.1.39.2 are immutable and contain
their original source code. Their recently supplied EXEs and blockmaps do not contain
these proposed new modules or MarksPanel changes.
