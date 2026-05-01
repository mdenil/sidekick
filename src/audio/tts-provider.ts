/**
 * @fileoverview TTS (text-to-speech) provider abstraction.
 *
 * Interface intentionally not adopted yet. Today's TTS path goes
 * through the audio-bridge directly (see
 * `audio-bridge/tts_bridge.py`): in WebRTC talk mode the server
 * attaches an outbound TTS track to the peer connection answer SDP
 * and the PWA plays it through a hidden `<audio srcObject>` element
 * (`src/pipelines/webrtc/connection.ts`). No PWA code currently
 * implements this interface.
 *
 * If the WebRTC TTS reliability migration ships (see
 * project_webrtc_tts_reliability) and switches talk-mode TTS to the
 * HTTP `/tts` proxy path, the natural shape is an
 * `HTTPTTSProvider implements TTSProvider` that POSTs `/tts` and
 * plays the returned audio through Web Audio. The interface is
 * preserved as a design breadcrumb for that future — keeping the
 * call-site contract narrow (speak / cancel / onState) lets that
 * migration land without touching every "speak this" caller.
 *
 * Like `STTProvider`, the shape is deliberately minimal: enough to
 * unbind callers from a specific vendor; not a full audio pipeline.
 */

/** Unsubscribe handle returned by listener-registering methods. */
export type Unsubscribe = () => void;

/** State of a TTS playback session. Granularity is deliberately
 *  coarse — finer-grained per-chunk progress is implementation-
 *  specific and not part of the contract. */
export type TTSPlaybackState =
  | 'idle'        // no playback in flight
  | 'synthesizing' // request issued, audio not yet playing
  | 'playing'     // audio is currently audible
  | 'paused'      // user (or barge) paused playback
  | 'error';      // synth or playback failed

/** Lifecycle for a streaming TTS provider.
 *
 *   speak(text, opts) requests synthesis + playback of `text`. If a
 *                     prior speak is still playing, implementations
 *                     MAY queue or interrupt — see provider docs.
 *                     Resolves when the audio has finished playing
 *                     (or rejects on error / cancel).
 *   cancel()          stops any in-flight playback and clears the
 *                     queue. Idempotent — safe to call when idle.
 *   onState(cb)       registers a state listener. Returns an
 *                     unsubscribe function.
 */
export interface TTSProvider {
  speak(text: string, opts?: { voice?: string }): Promise<void>;
  cancel(): Promise<void>;
  onState(cb: (state: TTSPlaybackState) => void): Unsubscribe;
}
