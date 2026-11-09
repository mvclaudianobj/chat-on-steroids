# Jarvis J — Windows push-to-talk preview

Jarvis has its own **Settings > Jarvis** page. It defaults to disabled.
Enable it, choose F8–F11, open an existing CLIProxy API conversation, and grant
microphone consent for this application session. Hold the configured key in the
composer or hold the Jarvis microphone button, then release. Jarvis uses the
Windows dictation recognizer, collects finalized words in memory, and sends
the recognized text to the active CLIProxy conversation after release. That
conversation's own model and Brain configuration handle the answer.

Speech synthesis uses the operating system's voice catalog and is disabled by
default. Enable it in Jarvis settings and choose the voice; a completed reply
to the voice-originated turn is spoken, up to 4,000 characters. Speech is
canceled when capture is canceled or the app window loses focus.

## Data and platform boundaries

- No recorded samples are written by Jarvis. The native Windows recognizer
  manages microphone access, recognizes speech, and returns text through the
  app's existing sanitized dictation IPC. Windows online speech recognition
  may send audio to Microsoft's speech service according to OS settings.
- CLIProxy receives only text through `apiChatSend` and the selected chat's
  configured model. Audio models listed by CLIProxy are **not** assumed to
  implement a working audio-transcription endpoint. The foundation contract
  in `src/shared/jarvis-ptt.ts` describes that future capability; it is not
  used to imply audio upload in this preview.
- On Linux/macOS the Jarvis microphone button is unavailable; local capture
  support must be added before the feature is offered on those systems.
- The language field optionally selects a Windows-recognized language and
  sets the synthesized output language. The corresponding Windows language
  must be installed. The field is empty by default, using the system language.
- The user selects the CLIProxy model in the API chat. The Jarvis panel
  deliberately reflects that source instead of storing a second conflicting
  model choice.
- Non-sensitive preferences are kept in local UI storage; microphone consent
  is process-memory only and defaults to absent on every app launch.

## Known validation gaps

Real hardware/OS microphone permission testing, an actual CLIProxy request,
manual Voice UX acceptance on Windows, a dedicated settings navigation entry,
and CLIProxy audio-model STT capability checks remain necessary for the full
cross-platform Jarvis delivery. TTS requires browser/OS speech synthesis.
