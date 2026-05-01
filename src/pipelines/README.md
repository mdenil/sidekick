# Audio pipelines

Sidekick's voice loop — the module cluster that owns mic-in →
speaker-out — lives here. The shell (`src/main.ts`, transcript,
attachments, settings, pocket-lock, ambient, canvas) is
pipeline-agnostic: it loads what's in `webrtc/` and exposes the call
toggles through the composer mic.

## What's actually here today

### `webrtc/` — full-duplex WebRTC voice (the live pipeline)

The only implementation. Mic and (optionally) TTS audio share a single
`RTCPeerConnection` to the audio bridge. Two modes use the same code
path; the difference is whether the server attaches a TTS audio track
to the answer SDP:

- **stream** — mic in, transcripts via SSE/data channel, no TTS audio.
- **talk** — mic in + TTS out on the same peer connection. iOS sees
  a real call session (lockscreen UI, BT routing, no background-audio
  gymnastics).

Files (each owns one concern, ~1600 LOC total):

- `connection.ts` — `RTCPeerConnection` lifecycle, getUserMedia,
  SDP offer/answer, track binding, mode flip.
- `controls.ts` — `toggleCall` / `closeIfOpen` / `isOpen` /
  `currentMode`. The composer-mic dispatch in `main.ts` calls these
  to open/close stream-mode or talk-mode calls. Mode derives from
  `settings.tts` at the time of call open.
- `dictation.ts` — per-call utterance buffer, silence timer, and
  commit-phrase regex. The bridge is a thin pass-through; the PWA
  decides when an utterance is "done" and tells the bridge to
  dispatch it via the data channel.
- `dictate.ts` — cursor-aware live dictation. Streams STT into the
  composer textarea while respecting the user's caret and edits.
  Used when the composer mic is in (call=true, autoSend=false).
- `suppress.ts` — drops user transcripts while the agent is replying
  to filter out speakerphone echo re-captured as mic input.

`types.ts` (sibling of this file) is JSDoc-only; it documents the
notional `AudioPipeline` shape and is preserved as a design breadcrumb
for the day a second pipeline shows up.

## Shared audio primitives

Not pipeline-specific. They live in `src/audio/`:

- `platform.ts` — capability flags + dispatch.
- `capture.ts` — mic + AudioContext lifecycle.
- `feedback.ts` — click / receive sound effects.
- `session.ts` — MediaSession integration for lockscreen / BT headset.
- `audio-processor.js` — AudioWorklet for mic peak + buffer.
- `micMeter.ts` — pub/sub for mic peak UI feedback.
- `memo.ts` — voice-memo MediaRecorder path (its own UX, not a pipeline).
- `tts-provider.ts` — interface intentionally not adopted yet
  (see file-level note).

iOS-specific (in `src/ios/`):

- `audio-unlock.ts` — iOS AudioContext gesture-unlock.

## Future pipelines

The Live-native pipeline shape (Gemini Live, OpenAI Realtime, etc.)
that the `conversational/` slot was reserved for is documented in
`docs/FUTURE_PIPELINES.md`. The directory itself was removed; if/when
that pipeline gets implemented, it can be added back as a peer of
`webrtc/` and a small dispatcher mirroring `src/backend.ts` can pick
between them based on a backend capability flag.
