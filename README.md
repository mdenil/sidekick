# Sidekick

**A voice-first PWA agent portal — bring your own backend.**

Hands-free chat with any agent that speaks the OpenAI Responses API. Configurable STT + TTS (Deepgram, ElevenLabs, OpenAI Whisper — easy to add others), lockscreen-friendly background audio for in-pocket use, WhatsApp-style voice memos, streaming voice keyboard, and full hands-free calling via WebRTC. Installable PWA shell that runs on anything from a Raspberry Pi to a cloud server.

<p align="center">
  <img src="docs/images/hero-desktop.png" alt="Sidekick on desktop — session drawer + agent reply with inline Google Maps directions card" width="640" />
  &nbsp;&nbsp;
  <img src="docs/images/hero-mobile.png" alt="Sidekick on iOS — same conversation in mobile portrait" width="200" />
  <br/>
  <em>Same conversation, two viewports.</em>
</p>

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/jscholz/sidekick/master/install.sh | bash
```

Clones into `./sidekick` in your current directory, installs deps, and boots:

- Sidekick proxy on `http://localhost:3001` (open this in a browser)
- Bundled stub agent on `:4001` (echo LLM, no API keys needed)

Add a [Deepgram](https://console.deepgram.com) key to `./sidekick/.env` to enable voice; everything else is optional.

Manual install:

```bash
git clone https://github.com/jscholz/sidekick.git
cd sidekick
cp .env.example .env
npm install
npm start
```

**Wiring up your own agent backend?** Sidekick ships with [`AGENTS.md`](AGENTS.md) — a short context file aimed at AI coding assistants (Claude Code, Cursor, Aider, ...). Open the cloned repo in your assistant of choice and say *"set sidekick up against my agent"*; the file gives it everything it needs (the contract, where to write the adapter, how to test).

## What's different

Most chat UIs treat voice as a bolt-on. Sidekick is voice-first:

- **Two handsfree modes** — turn-based (record-then-send) and realtime (full-duplex WebRTC). User picks per session.
- **Background-audio survival** — PWA stays alive on iOS lockscreen so you can talk to the agent while your phone is in your pocket. Pocket-lock overlay absorbs touches; mic + TTS + barge-in keep working.
- **Barge-in** — interrupt the agent mid-sentence by speaking. Client-side Silero VAD + per-device tuning.
- **Per-bubble TTS replay** — every agent reply has a play button. BT headset skip-fwd/back navigates between replies.
- **Bring your own agent** — speaks the OpenAI Responses API (`/v1/responses`, `/v1/conversations/*`). Drop-in compatible with any server that does, plus richer plugins for Hermes (and openclaw, soon).

## Backends

| Backend | Status | Use when |
|---|---|---|
| **stub** (in-tree) | ✅ Built-in default | First-clone demos, hermes-free dev, CI smoke runs. Echo / Gemini / Ollama LLM adapters. See [`backends/stub/README.md`](backends/stub/README.md). |
| **Hermes** | ✅ Bundled plugin | Full-featured agent — sessions, multi-platform drawer (Telegram/Slack/WhatsApp surface alongside sidekick), tool-call activity rows, attachment auto-routing through auxiliary vision. See [`backends/hermes/README.md`](backends/hermes/README.md). |
| **openclaw** | 🚧 Coming soon | Working sketch in [`docs/OPENCLAW_COMPATIBILITY.md`](docs/OPENCLAW_COMPATIBILITY.md). |
| **Any `/v1/responses`-compatible server** | ✅ Point `SIDEKICK_PLATFORM_URL` at it | OpenRouter, LMStudio, your own — see [`docs/ABSTRACT_AGENT_PROTOCOL.md`](docs/ABSTRACT_AGENT_PROTOCOL.md) for what's required vs. optional. |

## Configure

Two surfaces:

- **`.env`** — secrets (Deepgram, optional API keys). See [`.env.example`](.env.example).
- **`sidekick.config.yaml`** — non-secret deployment tuning (branding, theme, preferred-models filter, server ports). See [`example.sidekick.config.yaml`](example.sidekick.config.yaml). Point sidekick at it via `SIDEKICK_CONFIG=/path/to/file`.

The Settings panel inside the app handles per-user preferences (theme, mic device, TTS voice, STT keyterms, etc.) live without restart.

## Documentation

| Doc | What's in it |
|---|---|
| [Agent contract](docs/ABSTRACT_AGENT_PROTOCOL.md) | The `/v1/*` HTTP+SSE surface a backend MUST implement. Read before forking the proxy or implementing a new backend. |
| [Audio bridge protocol](docs/SIDEKICK_AUDIO_PROTOCOL.md) | WebRTC data-channel events, dispatch path, listening / barge envelopes. Read before forking `audio-bridge/`. |
| [Architecture](docs/ARCHITECTURE.md) | System diagram, module tree, endpoint inventory. |
| [Canvas protocol](docs/CANVAS.md) | Inline card envelopes (link previews, YouTube embeds, image grids). |
| [Capacitor plan](docs/CAPACITOR_PLAN.md) | iOS / Android native wrapper status. |
| [Backend READMEs](backends/) | One per backend — install steps, contract pieces implemented. |

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) for dev setup, test commands, and code style. Contributors using AI coding assistants should also read [`AGENTS.md`](AGENTS.md).

## License

MIT — see [`LICENSE`](LICENSE).
