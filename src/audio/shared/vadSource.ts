/**
 * @fileoverview VadSource — abstract source of "is the user speaking"
 * for BargeDetector.
 *
 * Two implementations:
 *   - ClientSideVadSource: in-browser Silero via @ricky0123/vad-web
 *     (delegates to ./speechVad). Best on iOS (WebRTC AEC + low-latency
 *     local detection); fragile on Mac (ONNX Runtime Web cold-start
 *     issues per microsoft/onnxruntime#19177).
 *   - BridgeVadSource: consumes {type:'speech-active'} envelopes that
 *     the audio bridge fires from server-side Silero + Deepgram interim
 *     transcripts. No client-side ONNX. The fix for desktop Chrome
 *     fragility; also enables multi-signal validation against TTS leak
 *     residual that fixed-amplitude gates can't separate at high volume.
 *
 * BargeDetector consumes a VadSource via its start() opts. The choice
 * is per-call (per per-route policy in headphones.ts), with a URL param
 * override for A/B testing. See docs/BARGE.md for the migration plan.
 *
 * The interface mirrors the surface the unified detector actually uses:
 * start/stop lifecycle, a synchronous isSpeechActive() read for the
 * fire decision, and getRecentPeak() for the optional iOS peak gate
 * (BridgeVadSource returns 0 — peak is a client-only concept since
 * the bridge already discriminates via multi-signal gates).
 */

import * as speechVad from './speechVad/index.ts';

export interface VadSourceOpts {
  /** Silero confidence above which a frame counts as speech-active. 0..1. */
  positiveSpeechThreshold?: number;
  /** Minimum sustained speech duration (ms) before fire. */
  minSpeechMs?: number;
  /** Optional gate for per-frame instrumentation log. Returns true when
   *  frame logs should fire (typically "TTS is currently playing"). */
  shouldLogFrames?: () => boolean;
}

export interface VadSource {
  /** Start the VAD session bound to micStream + opts. Resolves to true
   *  on successful warm; false if VAD couldn't start (e.g. unsupported
   *  platform). Bridge implementations resolve true once the data-channel
   *  subscription is wired — they don't have a model-load step. */
  start(micStream: MediaStream, opts: VadSourceOpts): Promise<boolean>;

  /** Stop the VAD session. Idempotent. */
  stop(): Promise<void>;

  /** Synchronous read: is speech currently active per this VAD's
   *  discriminator? Per-frame use is fine; this is just a Boolean read. */
  isSpeechActive(): boolean;

  /** Synchronous read: most-recent frame's peak amplitude (max abs sample,
   *  0..1). Returns 0 when no peak is available (BridgeVadSource has no
   *  concept of "peak" — the bridge does discrimination differently). */
  getRecentPeak(): number;
}

/** Production client-side VAD. Thin wrapper over the existing speechVad
 *  singleton — matches today's behavior exactly. */
export class ClientSideVadSource implements VadSource {
  async start(micStream: MediaStream, opts: VadSourceOpts): Promise<boolean> {
    return speechVad.start(micStream, opts);
  }

  async stop(): Promise<void> {
    return speechVad.stop();
  }

  isSpeechActive(): boolean {
    return speechVad.isSpeechActive();
  }

  getRecentPeak(): number {
    return speechVad.getRecentPeak();
  }
}

/** In-process fake — for unit tests. The detector reads isSpeechActive()
 *  per tick; tests drive synthetic sequences via setSpeechActive(). */
export class FakeVadSource implements VadSource {
  private speechActive = false;
  private peak = 0;
  private started = false;

  /** Set the speech-active flag the next tick will read. */
  setSpeechActive(active: boolean): void { this.speechActive = active; }

  /** Set the peak the next tick will read (for iOS minPeak gate tests). */
  setPeak(peak: number): void { this.peak = peak; }

  /** True between start() and stop(). Tests can assert on lifecycle. */
  isStarted(): boolean { return this.started; }

  async start(_micStream: MediaStream, _opts: VadSourceOpts): Promise<boolean> {
    this.started = true;
    return true;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.speechActive = false;
    this.peak = 0;
  }

  isSpeechActive(): boolean { return this.speechActive; }
  getRecentPeak(): number { return this.peak; }
}
