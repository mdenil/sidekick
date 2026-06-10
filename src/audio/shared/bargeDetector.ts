/**
 * @fileoverview Unified barge-in detector — single source of truth for
 * "the user wants to interrupt TTS." Replaces the duplicated loops that
 * previously lived in `audio/realtime/realtimeBarge.ts` and
 * `audio/turn-based/turnbased.ts`, each with their own setInterval +
 * BargeWindow + speechVad wiring.
 *
 * Detection design (VAD-only):
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
 * Test seam: pass a `FakeVadSource` (from ./vadSource) via opts.vadSource.
 * Tests drive synthetic speech sequences by calling fake.setSpeechActive()
 * and fake.setPeak() directly — no module-level overrides needed.
 *
 * VAD source is pluggable: ClientSideVadSource is the production default
 * (current Silero+vad-web behavior); BridgeVadSource consumes
 * {type:'speech-active'} envelopes from the bridge for desktop Chrome
 * (where ONNX Runtime Web cold-start fails per microsoft/onnxruntime#19177).
 * Per-route policy in headphones.ts picks the source.
 */

import { log } from '../../util/log.ts';
import { playFeedback } from './feedback.ts';
import { ClientSideVadSource, type VadSource } from './vadSource.ts';

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
  /** Minimum mic peak amplitude (max abs sample 0..1 from the most-
   *  recent VAD frame) required for fire. Filters out post-AEC residual
   *  agent voice (Silero says "speech" because the spectrum is intact,
   *  but peak amplitude is small) while still allowing real user
   *  speech (loud at the device). iOS sets this from voiceTuning's
   *  per-device default; other platforms leave it undefined and the
   *  gate is skipped. */
  minPeak?: number;
  /** VAD source — defaults to a fresh ClientSideVadSource. Production
   *  callers leave undefined (or pass ClientSideVadSource for iOS,
   *  BridgeVadSource for desktop per per-route policy); tests pass a
   *  FakeVadSource and drive speech-active state directly. */
  vadSource?: VadSource;
}

const DEFAULT_WARMUP_MS = 500;
const DEFAULT_FRAME_MS = 50;
const DEFAULT_COOLDOWN_MS = 2000;
// Silero minSpeechMs — minimum sustained speech-like energy required
// before isSpeechActive flips true. Bumped 150 → 400 to suppress
// wind/breathing/road-rumble false-fires on open-mic Bluetooth headsets.
// Wind has speech-shaped spectral content briefly but rarely sustains
// vocal-band character for 400ms; legitimate barge takes ~250ms longer
// to register — acceptable trade-off. Tunable per-call via
// BargeDetectorOpts.minSpeechMs if a quieter env wants snappier UX.
const DEFAULT_MIN_SPEECH_MS = 400;

// Module-level test override — kept for compatibility with the
// pre-VadSource smoke-test pattern where the test-harness injects
// `setSpeechActiveOverrideForTests(fn)` from outside the BargeDetector
// instance (e.g. `realtime-barge-client-side.mjs`). When set, the
// override takes precedence over `vadSource.isSpeechActive()` per tick.
// New unit tests should prefer dependency injection via opts.vadSource
// (FakeVadSource); this hook is for integration smoke tests that don't
// have a handle on the detector.
let speechActiveOverride: (() => boolean) | null = null;
let speechPeakOverride: (() => number) | null = null;

/** Test hook — when set, returns the override's value instead of the
 *  bound VadSource's isSpeechActive(). Pass null to restore. */
export function setSpeechActiveOverrideForTests(fn: (() => boolean) | null): void {
  speechActiveOverride = fn;
}
/** Test hook — same idea, for the optional iOS peak gate. */
export function setSpeechPeakOverrideForTests(fn: (() => number) | null): void {
  speechPeakOverride = fn;
}

export class BargeDetector {
  private opts: Required<Omit<BargeDetectorOpts, 'silentFire' | 'vadSource'>> & { silentFire: boolean } | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private warmupUntil = 0;     // ms timestamp; 0 means "armed on next isPlayingCb=true"
  private cooldownUntil = 0;   // ms timestamp; 0 means "no cooldown active"
  // The active VAD source — set in start() BEFORE the async vadSource.start()
  // resolves, cleared in stop(). Critical for the v0.422-era async-fire
  // race: if stop() runs while the VAD source is still warming, we still
  // tear it down so the next call's source binds to a fresh micStream.
  // Without this, vad=silent forever on call #2 because the in-flight
  // start resolved into an orphan that nobody owns.
  private vadSource: VadSource | null = null;
  // Diag tick counter — emit one line every 10 frames (~500ms at the
  // default cadence) so a "barge didn't fire" debugging session can see
  // exactly what the detector was deciding each tick. Distinguishes
  // VAD-says-no, in-warmup, in-cooldown, isPlayingCb-false, and
  // isEnabledCb-false reasons.
  private diagTickCount = 0;
  /** Last `enabled|warmup|cooldown|speech` state key emitted to the log
   *  relay. Used to suppress per-tick spam — only emit on transitions. */
  private lastDiagState = '';

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
      minPeak: opts.minPeak,  // undefined = no peak gate (Mac/Linux); iOS sets a value
    };
    // Bind the VAD source — caller-supplied or default to ClientSide.
    // Set BEFORE awaiting start() so a concurrent stop() can still tear
    // it down (handles the v0.422 hangup-during-warmup race).
    this.vadSource = opts.vadSource ?? new ClientSideVadSource();
    // Start the loop FIRST so ticks fire even if VAD never finishes
    // warming. tick() short-circuits (vad=silent) when the source isn't
    // ready, so this is safe — the only cost is wasted CPU on a few
    // no-op frames during cold start.
    this.loop = setInterval(() => this.tick(), this.opts.frameMs);
    log('[barge-detector] started — loop running, VAD warming async');
    // [audio-state] confirm the threshold value MicVAD is initialized
    // with. Pre-fix: always 0.5 (silero default). Post-fix: tracks the
    // user's slider. The slider trace in realtimeBarge.start logs the
    // OTHER end (what the slider says) so the gap is obvious.
    log('[audio-state] BargeDetector → MicVAD',
      `positiveSpeechThreshold=${this.opts.positiveSpeechThreshold}`,
      `minSpeechMs=${this.opts.minSpeechMs}`,
      `minPeak=${this.opts.minPeak ?? 'none'}`);
    // Fire VAD warm in the background. Pass isPlayingCb as the frame-log
    // gate so per-frame instrumentation only fires while agent TTS is
    // playing — that's when residual matters; pre-call silence isn't
    // useful to log.
    this.vadSource.start(opts.micStream, {
      positiveSpeechThreshold: this.opts.positiveSpeechThreshold,
      minSpeechMs: this.opts.minSpeechMs,
      shouldLogFrames: this.opts.isPlayingCb,
    }).then(ok => {
      log(ok ? '[barge-detector] VAD warm' : '[barge-detector] VAD failed to start — barge will not fire');
    }).catch((e: any) => {
      log('[barge-detector] vadSource.start threw:', e?.message);
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
    // Tear down the VAD source if we ever bound one, even if its start()
    // hasn't resolved yet. Otherwise the next call's source binds to a
    // dead micStream.
    if (this.vadSource) {
      const src = this.vadSource;
      this.vadSource = null;
      try { await src.stop(); } catch { /* noop */ }
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
    const speechActive = speechActiveOverride
      ? speechActiveOverride()
      : (this.vadSource?.isSpeechActive() ?? false);
    // Diag — log on STATE CHANGES only (logging every tick spammed
    // the relay during long calls). State transitions are still visible:
    // warmup→OK, cooldown→OK, vad silent→speech all emit a line.
    // Steady-state idle is silent.
    const stateKey = `${enabled}|${inWarmup}|${inCooldown}|${speechActive}`;
    if (stateKey !== this.lastDiagState) {
      this.lastDiagState = stateKey;
      log(
        `[barge-detector] state playing=${playing} enabled=${enabled} ` +
        `warmup=${inWarmup ? 'IN' : 'OK'} cooldown=${inCooldown ? 'IN' : 'OK'} ` +
        `vad=${speechActive ? 'speech' : 'silent'}`,
      );
    }
    if (!enabled) return;
    if (inWarmup) return;
    if (inCooldown) return;
    if (!speechActive) return;
    // Optional peak gate (iOS-only today). Filters out post-AEC residual
    // agent voice — Silero says "speech" because the residual retains
    // speech-shaped spectrum, but peak amplitude is 1/10th of real
    // user speech. Real user "stop" peaks at 0.3+; residual at 0.05.
    //
    // Skipped when:
    //   - minPeak undefined (Mac/Linux — full AEC, no residual concern)
    //   - vadSource.appliesPeakGate() === false (BridgeVadSource — its
    //     fires are post-AEC + hysteresis-filtered upstream; client-side
    //     peak isn't driven for bridge fires so peak reads 0 and would
    //     suppress 100% of fires).
    // While the page is backgrounded (lockscreen, app switcher), iOS
    // WKWebView throttles JS Web Audio — the AnalyserNode reads stale
    // / near-zero values even though the WebRTC mic upstream is still
    // flowing at full volume (the bridge's Silero correctly classifies
    // user speech). Peak reads near-zero when hidden, which suppresses
    // every barge attempt until the phone is unlocked.
    // Skip the peak gate when we're not visible — trust the bridge's
    // post-AEC Silero classification alone. AEC residual risk is low:
    // the bridge already runs Silero on POST-AEC audio, so residual
    // that survives Silero would be a different bug than the one this
    // gate was designed to catch (Web Audio AnalyserNode amplitude on
    // pre-AEC mic).
    const isVisible = typeof document === 'undefined'
      || document.visibilityState === 'visible';
    if (isVisible && typeof o.minPeak === 'number' && this.vadSource?.appliesPeakGate()) {
      const peak = speechPeakOverride
        ? speechPeakOverride()
        : (this.vadSource?.getRecentPeak() ?? 0);
      if (peak < o.minPeak) {
        log(`[barge-detector] suppressed — peak ${peak.toFixed(3)} < minPeak ${o.minPeak} (likely AEC residual)`);
        return;
      }
    } else if (!isVisible) {
      log(`[barge-detector] peak gate skipped (page hidden — trust bridge VAD)`);
    }
    // Fire — set cooldown FIRST so a re-entrant onFire (e.g. the
    // caller synchronously invokes something that loops back here)
    // can't double-fire.
    this.cooldownUntil = now + o.cooldownMs;
    // Peak in the fire log is forensic: the 2026-06-10 realtime self-barge
    // passed the 0.15 gate but the log couldn't say by how much.
    const firePeak = speechPeakOverride
      ? speechPeakOverride()
      : (this.vadSource?.getRecentPeak() ?? 0);
    log(`[barge-detector] fire (cooldown ${o.cooldownMs}ms, peak ${firePeak.toFixed(3)}, minPeak ${o.minPeak ?? 'none'})`);
    if (!o.silentFire) {
      try { playFeedback('barge'); } catch { /* noop */ }
    }
    try { o.onFire(); } catch (e: any) {
      log('[barge-detector] onFire threw:', e?.message);
    }
  }
}
