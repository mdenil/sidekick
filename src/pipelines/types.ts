/**
 * @fileoverview Audio pipeline contract.
 *
 * The pipeline is "what happens between the microphone and the speaker"
 * — it owns the voice loop and the reply-playback UX, and it consumes
 * backend reply events (chat.delta/final from BackendAdapter).
 *
 * Today there is one shipping pipeline:
 *
 *  1. WebRTC (full-duplex): mic + optional TTS audio share a single
 *     `RTCPeerConnection` to the audio bridge. Stream-mode = mic in,
 *     transcripts via SSE / data channel; talk-mode = mic in + TTS
 *     out on the same peer connection. Physical location:
 *     `src/pipelines/webrtc/`.
 *
 * Forward-looking pipeline shapes (Gemini Live, OpenAI Realtime, etc.)
 * are sketched in `docs/FUTURE_PIPELINES.md`. When one lands it can
 * sit as a peer of `webrtc/` and share the shape this file documents.
 * Shared audio primitives (mic capture, AudioContext unlock,
 * MediaSession, mic-peak notifier, audio feedback sounds) live in
 * `src/audio/` and any pipeline depends on them.
 *
 * This file is JSDoc only — the interface is currently aspirational
 * rather than enforced as a single facade, because the live WebRTC
 * pipeline is spread across `connection / controls / dictation /
 * dictate / suppress` and a unified-facade refactor would be large
 * for marginal benefit. The shell imports what it needs directly
 * from `pipelines/webrtc/`.
 *
 * When a second pipeline (e.g. Live-native) gets a real
 * implementation, this file will likely grow an explicit facade
 * typedef + a `loadPipeline()` dispatcher in `src/pipeline.ts`
 * mirroring `src/backend.ts`.
 */

// ─── Pipeline contract ──────────────────────────────────────────────────────

/**
 * What every pipeline must be able to do. (Not all entry points are called
 * by the shell in every mode — e.g. a Live-native pipeline ignores the
 * backend-reply hooks because the backend's audio stream IS the reply.)
 *
 * @typedef {Object} AudioPipeline
 *
 * @property {() => Promise<void>} init
 *   Called once at boot. Pipeline wires up DOM listeners, loads worklets,
 *   subscribes to settings, etc.
 *
 * @property {(stream: MediaStream) => Promise<void>} startListening
 *   Mic button pressed. WebRTC: start the peer connection. Live-native:
 *   open audio WS to backend.
 *
 * @property {() => Promise<void>} stopListening
 *
 * @property {(ev: import('../proxyClientTypes.js').DeltaEvent) => void} [onBackendDelta]
 *   WebRTC stream-mode: render text deltas. Live-native: no-op.
 *
 * @property {(ev: import('../proxyClientTypes.js').FinalEvent) => void} [onBackendFinal]
 *   WebRTC stream-mode: finalise the bubble. Live-native: no-op (the
 *   audio stream IS the reply).
 *
 * @property {(reason: string) => void} [stopPlayback]
 *   Stop whatever the pipeline is currently playing / synthesising.
 *
 * @property {() => 'idle' | 'playing' | 'paused' | 'ended' | 'stopped'} [getPlaybackState]
 *
 * @property {(event: string, fn: Function) => void} [on]
 * @property {(event: string, fn: Function) => void} [off]
 */

// ─── Capability flags ──────────────────────────────────────────────────────

/**
 * Advertised at pipeline-load time so the shell can hide UI that doesn't
 * apply to the active pipeline (e.g. per-bubble scrub bars make no sense
 * for Live-native).
 *
 * @typedef {Object} PipelineCapabilities
 * @property {boolean} clientSideStt   - Runs STT locally + produces text deltas the shell displays as a draft.
 * @property {boolean} clientSideTts   - Synthesises reply audio client-side per chunk.
 * @property {boolean} replayableReplies - Each reply has a retrievable audio blob (scrub bar, cache hits).
 * @property {boolean} interruptsLocally - Client-side barge-in detector (vs. server-side VAD).
 */

export {};
