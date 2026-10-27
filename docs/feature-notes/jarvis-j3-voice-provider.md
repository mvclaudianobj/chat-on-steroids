# Jarvis J3: voice provider and conversation flow

Jarvis is no longer limited to Windows dictation. Settings > Jarvis > **Voice provider** connects
any OpenAI-compatible speech service; the **g4f.space** preset (the provider MarksCode spoke
through) fills in public settings only: base `https://g4f.space/v1`, TTS `gpt-4o-mini-tts`,
voice `alloy`, STT through a Gemini chat model. The user
enters a primary key and a fallback key. They go to Vault K, bound to `https://g4f.space` with the
`Authorization` header, and the fallback is used when the primary answers 401, 403, 429 or 5xx.

Why it looked Windows-only: the main process denied every Chromium permission request, so the
J2 MediaRecorder never got the microphone on Linux or macOS and only Windows dictation (native,
outside Chromium) worked. J3 allows exactly one: an audio-only microphone request from the app's
own main frame. The renderer CSP gains `media-src blob:` so spoken replies can play.

When a provider is configured, the transcription order is provider → CLIProxy → local Whisper →
Windows. A failing engine hands the same recording to the next one.

## How the provider is called

- `GET {base}/models` fills the model suggestions and confirms that the key works.
- STT method **Audio transcription endpoint**: `POST {base}/audio/transcriptions`, multipart,
  with the recorded WebM/Ogg. If the provider rejects the format or returns empty text and
  ffmpeg is installed, the recording is converted to 16 kHz WAV in memory and sent once more.
- STT method **Multimodal chat model**: `POST {base}/chat/completions` with the WAV as
  `input_audio` and a verbatim-transcript instruction. This needs ffmpeg. It is the g4f.space
  preset because g4f.space's `/audio/transcriptions` currently returns `{"text": ""}`
  (MarkItDown backend) or a Pollinations budget message.
- TTS: `POST {base}/audio/speech` with `{model, input, voice, response_format: "mp3"}`, one
  request per sentence.

MarksCode itself (`packages/tui/src/markscode/tts.ts`) spoke through g4f.space's
`/ai/audio/{text}?voice=` route with a direct token and transcribed locally with whisper.cpp or
faster-whisper (`stt.ts`). J3 uses the standard OpenAI-compatible routes so that any provider
works, and keeps local Whisper as an engine.

## Conversation flow

After JARVIS-OS-V.2's speaking/listening/generation handling: the answer is read sentence by
sentence while the CLIProxy chat streams it. The next sentence is synthesized while the current
one plays, so audio starts after the first sentence. Each sentence's audio plays once its request
completes; the bytes are not streamed within a sentence. Push-to-talk during speech or thinking
interrupts at once (barge-in). Optional **Continuous conversation** listens again after the
spoken answer and sends after 1.4 s of silence. Short earcons mark start and end of listening.
The composer shows listening / transcribing / thinking / speaking.

## Live check (2026-10-23, synthetic phrase, keys from the process environment only)

| Step | Model | Latency | Result |
| --- | --- | --- | --- |
| `/models` | - | 120–140 ms | 124 models, no audio-specific ids |
| TTS | `gpt-4o-mini-tts`, voice `alloy` | 11.3 s first call, 0.9 s repeated | 89,856 bytes `audio/mpeg` |
| STT chat-audio | `srv_mrgy0nmbc8a86c407f17:models/gemini-3.5-flash-lite` | 8.6 s | "Olá, Jarvis. Este é um teste sintético de voz em português." |
| STT chat-audio | `srv_mrgy0nmbc8a86c407f17:models/gemini-2.5-flash` | 2.4 s | "olá Jarvis este é um teste sintético de voz em português" |
| STT chat-audio | `srv_mrgy0nmbc8a86c407f17:models/gemini-flash-latest` | timeout (60 s) | worked earlier the same day, then hung |
| STT transcriptions | `whisper-1` (WebM, then WAV retry) | 2.6 s | empty text: the provider returned nothing |

The phrase was spoken by the provider's TTS, re-encoded to WebM/Opus as Chromium's MediaRecorder
would record it, and transcribed through the product code in `src/main/jarvis-voice.ts`. The
fallback-key path is covered by unit tests against a fake server, not by breaking a real key.
g4f.space's `srv_…` model ids are server-specific and change; the settings page warns when the
chosen STT id is missing from the live list.
