# Jarvis J: push-to-talk foundation

This first slice is an **in-memory protocol**, not a working voice assistant. It adds
`src/shared/jarvis-ptt.ts` and targeted tests without enabling a microphone, exposing
an IPC handler, changing the chat timeline or contacting CLIProxyAPI.

## Contract

- Initial state is idle, with no model selected and consent set to false. Nothing
  starts on launch or after restoring application settings.
- Only explicit acknowledgement of **both microphone use** and **sending recorded
  audio to the configured CLIProxy endpoint** grants temporary consent. The future
  UI must collect this through a deliberate user action and respect operating-system
  microphone permissions; accepting an IPC payload is not proof of a user gesture.
- Model selection accepts audio identifiers recognized by the existing API-chat
  classifier. Actual availability and input/output capabilities must subsequently
  be verified against CLIProxyAPI's own catalog before enabling capture.
- Press produces a capture-start request only after consent and model selection.
  Release requests stop. A stopped capture may request transcription only when
  release occurred and audio exists. Cancel/revoke/close request cleanup; stale
  acknowledgements and late device startup cannot authorize a new recording.
- Effects contain only operation names, a local attempt number and, for the
  transcription request, the model identifier. The state and IPC-safe commands
  contain **no sound bytes, speech text, API keys or authorization headers**.
  The contract has no disk writer and retains consent only in process memory.

## Required integration work

1. Add a deliberate, accessible hold-to-talk UI, explicit consent and release on
   keyboard/mouse/touch end, window blur, navigation and quit. It must show which
   microphone and CLIProxy destination are active, and it must never auto-send text.
2. Implement the capture owner in the main process: bounded ephemeral audio memory,
   abortable startup, idempotent stop/discard, expiry and cleanup after crash/quit.
   Resolve OS microphone permissions before capture, recheck gesture ownership and
   process only the newest attempt. Keep raw samples out of renderer IPC and logs.
3. Connect the effect to a proven audio-capable CLIProxy model through the existing
   main-process secret store, with bounded request size/time and cancellable network
   work. Do not read credentials from system configuration files or send them to
   renderer. Speech output (TTS), playback and conversation routing remain separate
   future steps.
4. Add genuine integration/OS tests for capture permissions, abort races, teardown,
   network failure and real device behavior before calling Jarvis available in app.

Unit validation: `npx vitest run --maxWorkers=1 test/jarvis-ptt.test.ts`.
