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
import * as audioPlatform from './platform.ts';
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

  /** Whether BargeDetector should apply its iOS minPeak gate to fires
   *  from this source. The minPeak gate is a client-side AEC-residual
   *  filter: Silero says "speech" because spectrum is intact, but peak
   *  amplitude is 1/10th of real user speech.
   *
   *  ClientSideVadSource returns true — Silero runs on raw mic, peak is
   *  measured locally, the gate is the right tool.
   *  BridgeVadSource returns false — bridge runs Silero on POST-AEC PCM
   *  with hysteresis (7 sustained 32ms frames). The signal it emits is
   *  already filtered; layering a client peak gate on top has nothing to
   *  meaningfully gate against (peak isn't sourced for bridge fires)
   *  and 100% of fires get suppressed (field-confirmed 2026-05-07). */
  appliesPeakGate(): boolean;
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

  appliesPeakGate(): boolean { return true; }
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
 * ── Peak gate (added 2026-05-08 after iPhone field test) ─────────────
 *
 * Bridge VAD ALONE will fire on AEC residual at high speaker volume
 * (field-confirmed iPhone 2026-05-08: self-barged at "count 2" and
 * "count 4" while iPhone speaker was at normal volume; same hardware,
 * same AEC, but client mode with minPeak=0.15 gate suppressed the same
 * residual cleanly). To make bridge a drop-in equivalent for the
 * high-volume use case, we now run a lightweight local AnalyserNode
 * over the same micStream the bridge consumes and expose its
 * `recentPeak` so BargeDetector's iOS minPeak gate can apply.
 *
 * No ONNX, no wasm — just an AnalyserNode tap. Cheap.
 */
export type EnvelopeSubscriber = (cb: (ev: any) => void) => () => void;

export class BridgeVadSource implements VadSource {
  private speechActive = false;
  private unsubscribe: (() => void) | null = null;
  private subscribe: EnvelopeSubscriber;

  // Local peak meter — see "Peak gate" docstring above.
  private analyser: AnalyserNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private peakBuf: Uint8Array<ArrayBuffer> | null = null;
  private recentPeak = 0;
  private peakRafId: number | null = null;

  /** subscribe is injected for testability. Production callers pass
   *  the realtime module's `tapEnvelopes`; tests pass a stub that
   *  returns the listener so they can drive synthetic envelopes. */
  constructor(subscribe: EnvelopeSubscriber = tapEnvelopes) {
    this.subscribe = subscribe;
  }

  async start(micStream: MediaStream, _opts: VadSourceOpts): Promise<boolean> {
    if (this.unsubscribe) return true;
    this.unsubscribe = this.subscribe((ev) => {
      if (!ev || ev.type !== 'speech-active') return;
      const next = !!ev.active;
      if (next !== this.speechActive) {
        this.speechActive = next;
        log(`[bridge-vad] speech-active=${next}`);
      }
    });
    this.startPeakMeter(micStream);
    return true;
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.stopPeakMeter();
    this.speechActive = false;
  }

  isSpeechActive(): boolean { return this.speechActive; }

  getRecentPeak(): number { return this.recentPeak; }

  appliesPeakGate(): boolean { return true; }

  /** Local peak meter — AnalyserNode reads time-domain frames at RAF
   *  cadence (~60 Hz, plenty for a 200-300ms barge gate). Best-effort:
   *  on platforms where shared AudioContext isn't ready or
   *  createMediaStreamSource throws, we return false from
   *  appliesPeakGate so BargeDetector falls back to the unconditional
   *  pre-2026-05-08 behavior (no gate). */
  private startPeakMeter(micStream: MediaStream): void {
    if (this.analyser) return;
    try {
      const ctx = audioPlatform.getSharedAudioCtx();
      if (!ctx) {
        log('[bridge-vad] peak meter: no shared AudioContext, skipping gate');
        return;
      }
      this.sourceNode = ctx.createMediaStreamSource(micStream);
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 512;
      this.sourceNode.connect(this.analyser);
      // Explicit ArrayBuffer (not the SharedArrayBuffer the no-arg
      // ctor implies) so getByteTimeDomainData's strict typing accepts it.
      this.peakBuf = new Uint8Array(new ArrayBuffer(this.analyser.fftSize)) as Uint8Array<ArrayBuffer>;
      const tick = () => {
        if (!this.analyser || !this.peakBuf) return;
        this.analyser.getByteTimeDomainData(this.peakBuf);
        // Time-domain frames are uint8 centered at 128. Peak = max
        // distance from 128, normalized to [0..1] to match the iOS
        // minPeak gate's units.
        let maxAbs = 0;
        for (let i = 0; i < this.peakBuf.length; i++) {
          const v = Math.abs(this.peakBuf[i] - 128);
          if (v > maxAbs) maxAbs = v;
        }
        this.recentPeak = maxAbs / 128;
        if (typeof requestAnimationFrame !== 'undefined') {
          this.peakRafId = requestAnimationFrame(tick);
        }
      };
      tick();
    } catch (e: any) {
      log('[bridge-vad] peak meter setup failed:', e?.message);
      this.stopPeakMeter();
    }
  }

  private stopPeakMeter(): void {
    if (this.peakRafId !== null) {
      try { cancelAnimationFrame(this.peakRafId); } catch { /* noop */ }
      this.peakRafId = null;
    }
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch { /* noop */ }
      this.sourceNode = null;
    }
    this.analyser = null;
    this.peakBuf = null;
    this.recentPeak = 0;
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
  appliesPeakGate(): boolean { return true; }
}
