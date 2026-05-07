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
import { tapEnvelopes } from '../realtime/realtime.ts';
import { log } from '../../util/log.ts';

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

/**
 * Bridge-side VAD source. Subscribes to {type:'speech-active', active}
 * envelopes that the audio bridge fires from server-side Silero +
 * (eventually) Deepgram interim cross-check. No client-side ONNX —
 * the fix for desktop Chrome cold-start fragility.
 *
 * The bridge emits transitions only (one envelope per state change).
 * BridgeVadSource latches the most recent value and exposes it via the
 * synchronous isSpeechActive() that BargeDetector polls per tick.
 *
 * Note: subscribing before the data channel opens is required to catch
 * the first envelope. start() registers the tap synchronously, so the
 * subscription is live by the time the channel produces its first
 * message — this matches BargeDetector's real lifecycle (start runs
 * during call setup, before `connectionstatechange === 'connected'`).
 *
 * getRecentPeak() returns 0 — peak amplitude is a client-only concept.
 * The bridge does discrimination via Silero+hysteresis, not amplitude
 * gates, so feeding peak into the iOS minPeak gate would always read 0
 * and (wrongly) suppress fires. BargeDetector's peak-gate path skips
 * when the source returns 0; see bargeDetector.ts.
 */
export type EnvelopeSubscriber = (cb: (ev: any) => void) => () => void;

export class BridgeVadSource implements VadSource {
  private speechActive = false;
  private unsubscribe: (() => void) | null = null;
  private subscribe: EnvelopeSubscriber;

  /** subscribe is injected for testability. Production callers pass
   *  the realtime module's `tapEnvelopes`; tests pass a stub that
   *  returns the listener so they can drive synthetic envelopes. */
  constructor(subscribe: EnvelopeSubscriber = tapEnvelopes) {
    this.subscribe = subscribe;
  }

  async start(_micStream: MediaStream, _opts: VadSourceOpts): Promise<boolean> {
    if (this.unsubscribe) return true;
    this.unsubscribe = this.subscribe((ev) => {
      if (!ev || ev.type !== 'speech-active') return;
      const next = !!ev.active;
      if (next !== this.speechActive) {
        this.speechActive = next;
        log(`[bridge-vad] speech-active=${next}`);
      }
    });
    return true;
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.speechActive = false;
  }

  isSpeechActive(): boolean { return this.speechActive; }

  getRecentPeak(): number { return 0; }
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
