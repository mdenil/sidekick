/**
 * @fileoverview Unified barge-in detector — single source of truth for
 * "the user wants to interrupt TTS." Replaces the duplicated loops that
 * previously lived in `audio/realtime/realtimeBarge.ts` and
 * `audio/turn-based/turnbased.ts`, each with their own setInterval +
 * BargeWindow + speechVad wiring.
 *
 * Detection design (VAD-only, post-2026-05-04 simplification):
 *
 *   Fire condition = isPlayingCb() && isEnabledCb() && warmup-elapsed
 *                    && !in-cooldown && speechVad.isSpeechActive()
 *
 *   Silero VAD is the discriminator. RMS peak detection was dropped —
 *   VAD did all the discrimination work in practice (RMS gates anything
 *   loud; VAD discriminates speech vs transient). For the headphones
 *   scenario where barge actually needs to work, RMS contributed
 *   nothing positive. For the speaker-bleed scenario, neither RMS nor
 *   VAD can save us — only AEC can (re-enabled in realtime.ts for
 *   talk mode in the same batch as this module landed).
 *
 *   Per-fire cooldown (NEW): once the detector fires, it mutes itself
 *   for cooldownMs to prevent the "12 fires in 9 seconds" pattern field-
 *   observed during the agent's TTS playback when the user starts to
 *   speak. The cooldown auto-clears when isPlayingCb() flips back to
 *   false (TTS done) so the next reply gets a freshly-armed detector.
 *
 *   Warmup mute: 500 ms grace at the start of each TTS playback to
 *   absorb the worst speakerphone bleed transient before the platform's
 *   AEC adapter locks on.
 *
 * Lifecycle:
 *
 *   const det = new BargeDetector();
 *   await det.start({ micStream, isPlayingCb, isEnabledCb, onFire });
 *   // ... run the call ...
 *   await det.stop();
 *
 *   start() refcount-incs the shared speechVad instance and starts the
 *   per-frame loop. stop() decrements speechVad and clears the loop.
 *   Multiple detectors can coexist (e.g. a realtime call AND a Listen
 *   session both armed) — each holds one ref on speechVad.
 *
 * Test seam: `setSpeechActiveOverrideForTests(fn)` swaps the
 * speechVad.isSpeechActive() call for a test-supplied function so unit
 * tests can drive synthetic speech/non-speech sequences without the
 * actual WASM model. The lifecycle hooks (speechVad.start / stop) are
 * mocked separately via `speechVad.setVadLibForTests`.
 */

import { log } from '../../util/log.ts';
import { playFeedback } from './feedback.ts';
import * as speechVad from './speechVad/index.ts';

export interface BargeDetectorOpts {
  /** The mic MediaStream feeding both the WebRTC peer (or MediaRecorder)
   *  and our barge VAD. Shared with the caller's other audio paths;
   *  Silero attaches its own AudioWorklet to the same stream. */
  micStream: MediaStream;
  /** Returns true while TTS is actively playing — detector only ticks
   *  while this is true. Wired to suppress.isTtsPlaying() in realtime,
   *  to a state==='playing' check in turn-based. */
  isPlayingCb: () => boolean;
  /** User's barge-in toggle (settings.bargeIn). Same kill switch both
   *  modes have honored historically. */
  isEnabledCb: () => boolean;
  /** Called when the detector fires. Caller is responsible for halting
   *  TTS (sendBarge upstream + cancelRemotePlayback locally for realtime;
   *  cancelReplyTts + onBarge for turnbased). */
  onFire: () => void;
  /** Override the post-TTS-start warmup mute window. Defaults to 500 ms.
   *  Tests pass 0 to skip. */
  warmupMs?: number;
  /** Per-frame loop cadence. Defaults to 50 ms. */
  frameMs?: number;
  /** Post-fire cooldown — barge is muted for this long after firing,
   *  even if VAD keeps reporting speech. Auto-clears when isPlayingCb()
   *  goes false (next TTS turn re-arms cleanly). Defaults to 2000 ms. */
  cooldownMs?: number;
  /** Silero positiveSpeechThreshold (0..1). Lower = more sensitive.
   *  Defaults to 0.5 (vad-web's default). The user's "barge sensitivity"
   *  slider maps here in production. */
  positiveSpeechThreshold?: number;
  /** Silero minSpeechMs — minimum speech duration before onSpeechStart
   *  fires. Defaults to 150 ms. Higher = more reliable, slower. */
  minSpeechMs?: number;
  /** Suppress the audible 'barge' chime on fire — useful for tests. */
  silentFire?: boolean;
}

const DEFAULT_WARMUP_MS = 500;
const DEFAULT_FRAME_MS = 50;
const DEFAULT_COOLDOWN_MS = 2000;
// Silero minSpeechMs — minimum sustained speech-like energy required
// before isSpeechActive flips true. Bumped 150 → 400 (Jonathan, 2026-05-05)
// to suppress wind/breathing/road-rumble false-fires on bike (BT headset
// open mic). Wind has speech-shaped spectral content briefly but rarely
// sustains vocal-band character for 400ms; legitimate barge takes ~250ms
// longer to register, acceptable trade. Tunable per-call via
// BargeDetectorOpts.minSpeechMs if a quieter env wants snappier UX.
const DEFAULT_MIN_SPEECH_MS = 400;

/** Test-only override of `speechVad.isSpeechActive`. Unit tests inject a
 *  function returning the synthetic speech-active state for the current
 *  tick. Production code never touches this. */
let speechActiveOverride: (() => boolean) | null = null;

/** @internal — test hook. Pass null to restore the production read. */
export function setSpeechActiveOverrideForTests(fn: (() => boolean) | null): void {
  speechActiveOverride = fn;
}

function readSpeechActive(): boolean {
  return speechActiveOverride ? speechActiveOverride() : speechVad.isSpeechActive();
}

export class BargeDetector {
  private opts: Required<Omit<BargeDetectorOpts, 'silentFire'>> & { silentFire: boolean } | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private warmupUntil = 0;     // ms timestamp; 0 means "armed on next isPlayingCb=true"
  private cooldownUntil = 0;   // ms timestamp; 0 means "no cooldown active"
  // True from the moment we INVOKE speechVad.start, NOT from when it
  // resolves successfully. Critical for v0.422 async-fire correctness:
  // if a call ends before MicVAD.new() resolves, stop() must still
  // call speechVad.stop() to drop the in-flight reference, otherwise
  // activeVad gets bound to a dead micStream and the next call's
  // refcount path returns an unusable detector (the v0.423 bug
  // Jonathan caught — vad=silent forever on call #2 because MicVAD
  // was reading from call #1's killed stream). v0.424: also added
  // stream-identity check inside speechVad.start as a belt-and-
  // braces — if both fixes hold, only the BargeDetector flag matters.
  private vadStartCalled = false;
  // Diag tick counter — emit one line every 10 frames (~500ms at the
  // default cadence) so a "barge didn't fire" debugging session can see
  // exactly what the detector was deciding each tick. Distinguishes
  // VAD-says-no, in-warmup, in-cooldown, isPlayingCb-false, and
  // isEnabledCb-false reasons.
  private diagTickCount = 0;

  /** Start the detector. Returns IMMEDIATELY after the per-frame loop is
   *  running; speechVad.start is fired in the background so a slow
   *  MicVAD warmup (~3s cold, sometimes longer if the AudioWorklet
   *  load drags) doesn't block the caller. The loop reads
   *  isSpeechActive() per tick — returns false while VAD is loading,
   *  starts firing real values once VAD is hot.
   *
   *  PRE-v0.422 BUG: this method awaited speechVad.start before
   *  registering setInterval. When MicVAD.new hung indefinitely (Mac
   *  Chrome with successive call lifecycles, suspect AudioWorklet
   *  attachment race), the BargeDetector never started its loop and
   *  no tick logs appeared, making "barge didn't fire" debugging
   *  opaque. Async-fired now: setInterval is up before the await, so
   *  even if VAD warmup is slow/broken, ticks run and diag is visible. */
  async start(opts: BargeDetectorOpts): Promise<void> {
    this.stop();
    this.opts = {
      micStream: opts.micStream,
      isPlayingCb: opts.isPlayingCb,
      isEnabledCb: opts.isEnabledCb,
      onFire: opts.onFire,
      warmupMs: opts.warmupMs ?? DEFAULT_WARMUP_MS,
      frameMs: opts.frameMs ?? DEFAULT_FRAME_MS,
      cooldownMs: opts.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      positiveSpeechThreshold: opts.positiveSpeechThreshold ?? 0.5,
      minSpeechMs: opts.minSpeechMs ?? DEFAULT_MIN_SPEECH_MS,
      silentFire: opts.silentFire ?? false,
    };
    // Start the loop FIRST so ticks fire even if VAD never finishes
    // warming. tick() short-circuits (vad=silent) when speechVad isn't
    // ready, so this is safe — the only cost is wasted CPU on a few
    // no-op frames during cold start.
    this.loop = setInterval(() => this.tick(), this.opts.frameMs);
    this.vadStartCalled = true;  // see field docstring; flag flips on INVOKE, not resolve
    log('[barge-detector] started — loop running, VAD warming async');
    // [audio-state] confirm the threshold value MicVAD is initialized
    // with. Pre-fix: always 0.5 (silero default). Post-fix: tracks the
    // user's slider. The slider trace in realtimeBarge.start logs the
    // OTHER end (what the slider says) so the gap is obvious.
    log('[audio-state] BargeDetector → MicVAD',
      `positiveSpeechThreshold=${this.opts.positiveSpeechThreshold}`,
      `minSpeechMs=${this.opts.minSpeechMs}`);
    // Refcount-inc the shared VAD in the background.
    speechVad.start(opts.micStream, {
      positiveSpeechThreshold: this.opts.positiveSpeechThreshold,
      minSpeechMs: this.opts.minSpeechMs,
    }).then(ok => {
      log(ok ? '[barge-detector] VAD warm' : '[barge-detector] VAD failed to start — barge will not fire');
    }).catch((e: any) => {
      log('[barge-detector] speechVad.start threw:', e?.message);
    });
  }

  /** Stop the detector. Idempotent — safe to call when not started. */
  async stop(): Promise<void> {
    if (this.loop) {
      clearInterval(this.loop);
      this.loop = null;
    }
    this.warmupUntil = 0;
    this.cooldownUntil = 0;
    this.opts = null;
    // Always tell speechVad we're done if we ever called start —
    // even if MicVAD.new hasn't resolved yet. Otherwise we leak a
    // ref + bind it to a dead micStream for the next caller.
    if (this.vadStartCalled) {
      this.vadStartCalled = false;
      try { await speechVad.stop(); } catch { /* noop */ }
    }
  }

  /** Synchronous read of detector state — true when running. For diag
   *  logs and test assertions. */
  isRunning(): boolean {
    return this.loop !== null;
  }

  private tick(): void {
    const o = this.opts;
    if (!o) return;
    const playing = o.isPlayingCb();
    if (!playing) {
      // TTS not playing — clear timers so the next playback re-warms
      // and re-arms the detector cleanly. NOT clearing on the
      // isEnabledCb path so a temporary toggle-off doesn't reset the
      // warmup mid-playback.
      this.warmupUntil = 0;
      this.cooldownUntil = 0;
      return;
    }
    const enabled = o.isEnabledCb();
    const now = Date.now();
    // First tick after isPlayingCb flipped to true — arm warmup mute.
    if (this.warmupUntil === 0) {
      this.warmupUntil = now + o.warmupMs;
    }
    const inWarmup = now < this.warmupUntil;
    const inCooldown = now < this.cooldownUntil;
    const speechActive = readSpeechActive();
    // Diag tick — every ~500ms during playback, log the decision state
    // so a "didn't fire" failure is debuggable from the chat log.
    this.diagTickCount++;
    if (this.diagTickCount % 10 === 0) {
      log(
        `[barge-detector] tick playing=${playing} enabled=${enabled} ` +
        `warmup=${inWarmup ? 'IN' : 'OK'} cooldown=${inCooldown ? 'IN' : 'OK'} ` +
        `vad=${speechActive ? 'speech' : 'silent'}`,
      );
    }
    if (!enabled) return;
    if (inWarmup) return;
    if (inCooldown) return;
    if (!speechActive) return;
    // Fire — set cooldown FIRST so a re-entrant onFire (e.g. the
    // caller synchronously invokes something that loops back here)
    // can't double-fire.
    this.cooldownUntil = now + o.cooldownMs;
    log(`[barge-detector] fire (cooldown ${o.cooldownMs}ms)`);
    if (!o.silentFire) {
      try { playFeedback('barge'); } catch { /* noop */ }
    }
    try { o.onFire(); } catch (e: any) {
      log('[barge-detector] onFire threw:', e?.message);
    }
  }
}
