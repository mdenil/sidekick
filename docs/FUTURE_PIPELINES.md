# Future audio pipelines

Forward-looking design notes for pipeline shapes that may eventually
land alongside `src/pipelines/webrtc/` (the live pipeline). Today
nothing implements these — they're documented here so a future
implementer doesn't have to re-derive the shape from scratch.

## Live-native (Gemini Live, OpenAI Realtime, etc.)

Route raw audio frames from the mic directly to a backend that speaks
a bidirectional audio protocol, and render the audio that comes back
out of the speaker — no client-side STT, no client-side TTS.

The backend exposes a WebSocket. Client opens a session, streams
16-bit PCM frames upward, receives PCM frames + transcript chunks +
tool-call events downward.

### What it would do

- Open / close a per-session audio WebSocket against the Live backend.
- Forward mic frames upward at the protocol's expected rate.
- Render downstream audio frames through a Web Audio output.
- Surface input + output transcript events into the existing draft /
  transcript UI. Chat bubbles still exist; they just have no play
  button.

### What it would NOT do

- Synthesise TTS per reply (the server does it).
- Run client-side barge-in VAD (the server has its own interrupt
  detection).
- Chunked reply-scrub playback UI — Live's audio is a continuous
  stream, not discrete chunks.
- Reply replay via cached AudioBuffer (punted at design time).

### Contract touchpoints

A future implementation should:

1. Export `startListening(stream)` / `stopListening()` — opens / closes
   the backend's audio session. The composer mic dispatch in
   `src/main.ts` calls these.
2. Subscribe to backend transcript events (both input and output
   transcription) and route them into the existing draft / transcript
   UI.
3. Ignore `onBackendDelta` / `onBackendFinal` from the backend
   adapter — the backend doesn't emit those in Live mode. It emits
   transcript events as a side-channel.
4. Bridge interruption: server VAD decides when the user has started
   speaking; the client just observes.
5. Handle session limits (Gemini Live = 15 min audio) — mint a new
   session transparently, optionally with a handoff message so the
   user's context carries over.

### Recommended order of operations

1. Write a 200-line standalone Gemini Live client as a sanity check —
   pure WS, pure audio in / out, no app integration. Validate the
   protocol shape in isolation.
2. Add a `src/geminilive.ts` adapter with
   `capabilities.conversationalVoice: true`. Standard chat methods
   can no-op or throw — the shell never calls them because it'll
   take the conversational dispatch branch.
3. Build the pipeline module under `src/pipelines/<name>/` with the
   entry points above. Mirror the file layout of `webrtc/`
   (`connection.ts`, `controls.ts`, etc.) so the shell binding looks
   the same.
4. Add a small `src/pipeline.ts` dispatcher that reads the backend's
   `conversationalVoice` capability flag and lazy-loads the right
   pipeline. The shape mirrors `src/backend.ts`.
5. Feature-flag the whole thing until it's proven on a real commute.

The interface in `src/pipelines/types.ts` (JSDoc-only) captures the
notional `AudioPipeline` shape; if/when a second pipeline shows up
that JSDoc can graduate into a real TypeScript interface enforced by
the dispatcher.
