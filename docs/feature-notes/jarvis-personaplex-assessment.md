# Jarvis: NVIDIA PersonaPlex assessment (not installed)

[NVIDIA PersonaPlex](https://github.com/NVIDIA/personaplex) (`nvidia/personaplex-7b-v1`) is a
full-duplex speech-to-speech model. It listens and speaks at the same time, handles interruptions
and backchannels, and sets its persona from a text prompt and a voice sample. It is a fine-tune of
Kyutai's Moshi (Helium LLM plus the Mimi codec).

## What it needs

| Item | PersonaPlex (from the repository and model card, 2026-10) |
| --- | --- |
| Size | 7B parameters (the model card's metadata says 8B), BF16 safetensors, so about 15–16 GB of weights |
| GPU | Tested on A100 80 GB; the card lists Ampere and Hopper. No minimum VRAM is published |
| Low-memory mode | `--cpu-offload` (needs `accelerate`) moves layers to the CPU. No int8/int4 build is published |
| Runtime | Python + PyTorch on Linux, `libopus-dev`, a Hugging Face token with the license accepted |
| Interface | `python -m moshi.server` with a web UI on `localhost:8998` (WebSocket audio), or an offline WAV-in/WAV-out script |
| Audio | 24 kHz in and out |
| Languages | **English only** ("English speech response for English speech input") |
| Licenses | Code MIT; weights under the NVIDIA Open Model License |
| Latency (card) | turn-taking 0.17, user interruption 0.24 (units not stated; seconds in the paper's benchmark) |

## This machine

RTX 4060 Laptop GPU with **8 GB** VRAM, 31 GB RAM, 24 threads, Linux Mint 22.3, Python 3.12.

- The BF16 weights alone are about twice the VRAM. It runs here only with `--cpu-offload`, and a
  model split across PCIe and the CPU cannot keep a full-duplex 12.5 Hz frame loop in real time.
  Expect stutter or several times real time, which defeats the purpose of full duplex.
- No published quantized build exists. Community 4/8-bit Moshi builds (MLX, candle) are not
  PersonaPlex and do not carry its persona/voice conditioning.
- English only: the user speaks Portuguese, so the main Jarvis use case is not covered.
- It replaces the whole loop (STT + LLM + TTS). The answer would come from the 7B Helium model,
  not from the CLIProxy chat model and its Brain, tools and approvals that Jarvis is built around.

## Recommendation

Do **not** add it now. Revisit it as an optional, separately installed local engine only when
(a) a multilingual (Portuguese) checkpoint exists, and (b) a quantized build fits in 8 GB with
real-time frames, or the user has a 24 GB+ GPU. If it is added, keep it out of process: Chat
Marks would talk to the user's own `moshi.server` on loopback (`ws://127.0.0.1:8998`), never
install Python packages or download weights itself, and treat it as a "voice-only conversation"
mode separate from CLIProxy chats, since it cannot use their model, tools or Brain.

Until then the J3 path gives most of the fluency on this hardware: provider or local STT,
sentence-by-sentence TTS that starts while the answer streams, barge-in on push-to-talk and an
optional continuous mode.
