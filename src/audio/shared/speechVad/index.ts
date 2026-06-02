/**
 * @fileoverview Silero VAD WebAssembly adapter — wraps `@ricky0123/vad-web`'s
 * MicVAD into the surface the barge detectors need: start(stream), stop(),
 * onSpeechStart/End subscriptions, isSpeechActive(), isSupported().
 *
 * Silero is a tiny (1.8 MB) ONNX model trained as a binary speech /
 * non-speech classifier. It's the SOLE discriminator for barge fires
 * (RMS gate retired 2026-05-04). Sensitivity is controlled via
 * `positiveSpeechThreshold` (0..1) which the user's slider drives via
 * settings.bargeVadThreshold.
 *
 * Implementation notes:
 *   - The vad-web library is loaded LAZILY via dynamic import of the
 *     bundled ESM at /build/vendor/vad-web.mjs (≈ a few hundred KB; not
 *     pulled into the page's initial JS).
 *   - vad-web's MicVAD opens its OWN MediaStream by default. We override
 *     `getStream` to return the caller-supplied stream so we don't open a
 *     second mic — sharing the AnalyserNode-source stream is critical on
 *     iOS where multiple getUserMedia calls fight for the same hardware.
 *   - vad-web internally adds an AudioWorklet to the AudioContext for
 *     16 kHz resampling + framing. We pass our shared AudioContext so it
 *     stays gesture-bound to the user's primeAudio() call.
 *   - All subscriber state lives here (not in the underlying MicVAD)
 *     so multiple BargeWindow callers can observe one VAD instance.
 *
 * iOS caveats:
 *   - Safari 16+ supports AudioWorklet + WebAssembly + AudioWorklet
 *     transferred audio. We need iOS 16.4+ for SharedArrayBuffer-free
 *     ORT WASM (single-threaded). The bundled wasm we ship is the
 *     non-threaded ort-wasm-simd-threaded.wasm (the runtime falls back
 *     to single-thread when COOP/COEP isn't set, which we don't set).
 *   - MicVAD.new() resolves after the worklet + model load. On iPhone 15
 *     this is ~200-300ms cold; warm subsequent calls are <50 ms.
 *     Adapter buffers the load promise so duplicate start() calls during
 *     warm-up don't double-load.
 */

import { log } from '../../../util/log.ts';
import * as audioPlatform from '../platform.ts';

/** Tunable knobs exposed to callers. Defaults match @ricky0123/vad-web's
 *  legacy-Silero recommended settings; barge-tuning overrides come later
 *  if field testing shows the defaults misfire. */
export type SpeechVADOptions = {
  /** Silero score above which a frame is considered speech. 0..1.
   *  Default 0.5 (vad-web default). Lower → more sensitive (more false
   *  positives), higher → fewer triggers (may miss soft speech). */
  positiveSpeechThreshold?: number;
  /** Score below which a frame is considered NOT speech. Default 0.35
   *  (vad-web default; ~0.15 below positive). Hysteresis band between
   *  this and positiveSpeechThreshold prevents per-frame chatter. */
  negativeSpeechThreshold?: number;
  /** How many ms of sub-negative scores trigger speechEnd. Default 1400.
   *  Barge cares about speechSTART so this mostly affects when the
   *  isSpeechActive() flag drops back to false. */
  redemptionMs?: number;
  /** Minimum speech duration to fire onSpeechStart. Default 150 ms via
   *  minSpeechMs. Filters single-frame model jitter. */
  minSpeechMs?: number;
  /** Optional gate for the [audio-state] vad-frame instrumentation
   *  log. Returns true when frame logs should fire (e.g. only while
   *  agent TTS is playing — that's when we care about residual). When
   *  not provided, frames log unconditionally at the throttled cadence. */
  shouldLogFrames?: () => boolean;
};

type Unsubscribe = () => void;

/** Bundle URL — esbuild's vendor bundle (see scripts/build.mjs). The
 *  /build/* prefix is served from the same origin as the page; the
 *  service worker network-firsts /build/* so updates land cleanly. */
const VAD_BUNDLE_URL = '/build/vendor/vad-web.mjs';

/** Asset directory — model + worklet + ort wasm all live under
 *  /assets/vad/. Pre-cached by the service worker (sw.js APP_SHELL).
 *  Trailing slash is required: vad-web concatenates filename onto the
 *  base path with no separator. */
const VAD_ASSET_BASE = '/assets/vad/';

let vadLib: typeof import('@ricky0123/vad-web') | null = null;
let supportProbed: boolean | null = null;
let testCtxOverride: AudioContext | null = null;

/** Single shared adapter. v0.424: refcount removed — every start()
 *  builds a fresh MicVAD bound to the caller's micStream, and every
 *  stop() destroys it. Reasoning: the prior refcount design assumed
 *  the same MediaStream identity across callers, but each WebRTC
 *  call lifecycle creates a NEW micStream. Refcount-reusing an old
 *  MicVAD meant the second call's "barge" was bound to the dead
 *  first-call stream and never saw any frames (vad=silent forever —
 *  the dead-stream bug). With refcount gone,
 *  stream identity is naturally fresh per start().
 *
 *  The cost: each call rebuilds MicVAD (~1s on M1 Mac, ~3s cold on
 *  iPhone). That's the cost of correctness; pre-warm via the
 *  prefetch path makes subsequent rebuilds fast (cached wasm). */
let activeVad: MicVADHandle | null = null;
type MicVADHandle = {
  inst: any; // MicVAD — typed via dynamic import; avoid synthetic dep on the lib
  micStream: MediaStream;  // identity check on subsequent start() calls
  speechActive: boolean;
  startListeners: Set<() => void>;
  endListeners: Set<() => void>;
};

// In-flight start tracking. Increments on every start() invocation.
// stop() reads this and bumps it so a pending MicVAD.new resolution
// observes that its generation is stale and destroys itself instead
// of becoming the new activeVad. Without this, hanging up DURING the
// MicVAD.new warmup race leaves the resolved inst un-tracked and
// un-destroyed (the v0.424 smoke caught this).
let startGen = 0;
// Frame counter for throttled per-frame audio-state logging — see
// onFrameProcessed below. Resets implicitly on JS context restart.
let frameCounter = 0;
// Most-recent frame's peak amplitude, exposed via getRecentPeak().
// Used by BargeDetector's optional minPeak gate to distinguish real
// user speech (peak 0.3+) from post-AEC residual agent voice
// (peak 0.05 typical) when both produce high p_speech values.
// Updated on EVERY frame (not throttled like the log) so the gate
// has fresh data. Resets to 0 on speechVad.stop() so a stale read
// from a closed call can't gate a new call's first fire.
let recentPeak = 0;

/** Has the vad-web library been loaded and reported usable in this browser?
 *  Probed on first call; subsequent calls return the cached answer. */
export async function isSupported(): Promise<boolean> {
  if (supportProbed !== null) return supportProbed;
  if (typeof window === 'undefined') return (supportProbed = false);
  // AudioWorklet is the hard dep — vad-web falls back to ScriptProcessor
  // but Silero needs 16 kHz frames at 32 ms each, the worklet path is
  // the only one we want firing in production.
  if (typeof AudioWorkletNode === 'undefined') {
    log('[speechVad] AudioWorkletNode unavailable — falling back to RMS-only');
    return (supportProbed = false);
  }
  try {
    vadLib = await import(/* webpackIgnore: true */ VAD_BUNDLE_URL);
    supportProbed = !!vadLib?.MicVAD;
    return supportProbed;
  } catch (e: any) {
    log('[speechVad] vad-web bundle load failed:', e?.message);
    vadLib = null;
    return (supportProbed = false);
  }
}

/** Synchronous read of the last-probed support flag. Returns false until
 *  isSupported() has resolved at least once. Callers in hot paths should
 *  await isSupported() during init, then use this for per-frame checks. */
export function isSupportedSync(): boolean {
  return supportProbed === true;
}

/** Start a VAD session against the given mic stream. Idempotent at the
 *  process level — duplicate start() calls increment a refcount instead
 *  of building a second MicVAD. The first start() actually constructs
 *  the worklet + model; subsequent starts just attach subscribers.
 *
 *  Returns false when VAD is unavailable (caller should fall back to
 *  RMS-only); true when a usable session is running. */
export async function start(
  micStream: MediaStream,
  opts: SpeechVADOptions = {},
): Promise<boolean> {
  // Capture this start's generation. If stop() is called while
  // MicVAD.new is in flight, it bumps startGen so the resolved inst
  // sees `myGen !== startGen` and destroys itself.
  const myGen = ++startGen;
  // Phase timer — every log line includes ms-since-start so a future
  // "MicVAD timed out after 5s" complaint is debuggable from the chat
  // log alone (which step actually hung — bundle import, addModule,
  // model fetch). Each phase boundary emits one diagnostic line.
  const phaseT0 = performance.now();
  const phase = (label: string) => log(`[speechVad] ${label} +${Math.round(performance.now() - phaseT0)}ms`);
  phase('start() entered');
  const supported = await isSupported();
  phase(`isSupported=${supported} vadLib=${!!vadLib}`);
  if (!supported || !vadLib) return false;

  // Stream-revoked subscription. If the caller's mic stream's track
  // ends mid-init (e.g. user hangs up while MicVAD is still loading
  // wasm/worklet), we want to abort fast instead of waiting on the
  // 5s watchdog. Bumping startGen makes the resolved inst self-
  // destruct via the post-resolve check below.
  //
  // Defensive: unit tests pass minimal MediaStream stubs without
  // getAudioTracks; callers should always pass real streams in
  // production but we avoid throwing on a stub. Without the listener,
  // hangup-during-init falls back to the 5s watchdog (still safe,
  // just slower than the fast-abort path).
  let trackEnded = false;
  let audioTrack: MediaStreamTrack | null = null;
  try {
    audioTrack = micStream.getAudioTracks?.()[0] ?? null;
  } catch { /* malformed stub stream */ }
  const onTrackEnded = () => {
    trackEnded = true;
    log('[speechVad] track ended mid-init — bumping startGen to abort');
    startGen++;
  };
  if (audioTrack) {
    if (audioTrack.readyState === 'ended') {
      onTrackEnded();
    } else {
      audioTrack.addEventListener('ended', onTrackEnded, { once: true });
    }
  }
  const detachTrackListener = () => {
    if (audioTrack) audioTrack.removeEventListener('ended', onTrackEnded);
  };

  // Stream identity check — if there's an existing activeVad bound to
  // a DIFFERENT micStream (e.g. previous call ended, new call has a
  // fresh getUserMedia stream), tear down the old one before building
  // a new one. Otherwise MicVAD reads dead-stream frames forever.
  if (activeVad && activeVad.micStream !== micStream) {
    phase('stream identity changed — tearing down stale activeVad');
    try { await activeVad.inst.destroy(); } catch { /* noop */ }
    activeVad = null;
  }

  // Same-stream re-entrant start (rare: two callers on the same
  // capture session). Reuse without rebuild.
  if (activeVad) {
    phase('reusing activeVad (same micStream)');
    detachTrackListener();
    return true;
  }

  const ctx = testCtxOverride ?? audioPlatform.getSharedAudioCtx();
  if (!ctx) {
    phase('no shared AudioContext — primeAudio() must run first');
    detachTrackListener();
    return false;
  }
  if (ctx.state === 'suspended') {
    phase('ctx suspended — resuming before MicVAD.new()');
    try { await ctx.resume(); } catch (e: any) {
      log('[speechVad] ctx.resume() threw:', e?.message);
    }
  }
  phase(`ctx.state=${ctx.state} — about to await prefetch then call MicVAD.new()`);

  // Wait for the page-load prefetch to populate the SW cache before
  // we let MicVAD.new fire its own fetch. On hostile networks the model
  // fetch alone can take >30s — well past our 15s watchdog. Without this
  // gate, MicVAD.new's fetch gets cancelled mid-download, the SW
  // cache never populates, and every retry fails identically.
  // With it, we block the FIRST call long enough for the cache to
  // populate; every subsequent call is instant. On fast networks the
  // prefetch finishes long before any user click, no perceptible delay.
  try {
    const pf: Promise<void> | undefined = (typeof window !== 'undefined') ? (window as any).__vadPrefetchPromise__ : undefined;
    if (pf) {
      phase('awaiting prefetch promise');
      await pf;
      phase('prefetch promise resolved');
    }
  } catch (e: any) {
    log('[speechVad] prefetch promise rejected (proceeding anyway):', e?.message);
  }

  try {
    // Watchdog: if MicVAD.new hangs we want a visible failure instead
    // of a silent never-resolving promise.
    //
    // History:
    //   Initial: 10s — generous to start
    //   Tightened to 5s (assumed phase logs would localize
    //           hangs; assumed warm cache was the common case)
    //   Bumped back to 15s: cold
    //   first-call on Mac Chrome over Tailscale needs ~6s for the
    //   /build/vendor/vad-web.mjs dynamic import alone (cold TLS +
    //   HTTP/2 connection setup), then ~5-8s for model fetch + ORT
    //   wasm init. 5s cut us off mid-fetch and the cache never
    //   populated → every retry was equally slow. 15s gives the
    //   cold-cache path room to actually succeed; subsequent calls
    //   hit warm cache and resolve in <500ms regardless.
    const watchdog = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('MicVAD.new timeout after 15s')), 15_000);
    });
    const inst = await Promise.race([watchdog, vadLib!.MicVAD.new({
      // Reuse the caller's mic stream — DO NOT open a second one. iOS
      // hardware-binds the AudioContext to the first stream that owns
      // it; a second getUserMedia steals capture on Safari and produces
      // silent frames in WebRTC's encoder.
      getStream: async () => micStream,
      // The pause/resume hooks fire during MicVAD.pause()/destroy(); we
      // never call those (we drive the lifecycle externally), but the
      // library expects them to be present. Stub to no-ops so the
      // user's stream isn't toggled out from under WebRTC.
      pauseStream: async () => { /* no-op */ },
      resumeStream: async () => micStream,
      audioContext: ctx,
      // Silero legacy is 1.8 MB vs. v5's 2.3 MB and has the same
      // detection quality at our threshold. Smaller model → faster
      // cold-start, smaller cache footprint.
      model: 'legacy',
      baseAssetPath: VAD_ASSET_BASE,
      onnxWASMBasePath: VAD_ASSET_BASE,
      // We auto-start because the first start() call already implies
      // "begin listening." MicVAD's startOnLoad: false would require
      // an extra .start() round-trip we don't need.
      startOnLoad: true,
      processorType: 'AudioWorklet',
      // Tunables — defaults pulled from getDefaultRealTimeVADOptions
      // for the legacy model, with caller overrides applied.
      positiveSpeechThreshold: opts.positiveSpeechThreshold ?? 0.5,
      negativeSpeechThreshold: opts.negativeSpeechThreshold ?? 0.35,
      redemptionMs: opts.redemptionMs ?? 1400,
      minSpeechMs: opts.minSpeechMs ?? 150,
      onSpeechStart: () => {
        if (!activeVad) return;
        activeVad.speechActive = true;
        for (const cb of activeVad.startListeners) {
          try { cb(); } catch (e: any) { log('[speechVad] onSpeechStart cb threw:', e?.message); }
        }
      },
      onSpeechEnd: () => {
        if (!activeVad) return;
        activeVad.speechActive = false;
        for (const cb of activeVad.endListeners) {
          try { cb(); } catch (e: any) { log('[speechVad] onSpeechEnd cb threw:', e?.message); }
        }
      },
      onVADMisfire: () => {
        // Sub-minSpeechMs blip — drop the speechActive flag without
        // firing onSpeechEnd (vad-web's contract). Keeps mechanical-
        // transient behavior consistent with our intent: VAD says NOT
        // speech, callers should not have already barged.
        if (activeVad) activeVad.speechActive = false;
      },
      // [audio-state] per-frame instrumentation. Logs the audio energy
      // Silero is reading (peak + RMS of the 32ms frame's samples) and
      // the model's speech-probability output. Throttled + gated:
      //   - cadence: every 4th frame (~125 ms) — fine enough to see
      //     post-AEC residual bursts that drive Silero misfire
      //   - gate: only while shouldLogFrames() returns true (typically
      //     bound to "is agent TTS currently playing" — that's when
      //     we care; we don't need 8 logs/sec during silence/setup)
      // Remove once the iOS self-barge is closed out.
      onFrameProcessed: (probabilities: any, frame: Float32Array) => {
        // Compute peak EVERY frame (cheap loop, used by getRecentPeak()
        // for the BargeDetector minPeak gate). RMS + log are throttled.
        let peak = 0;
        for (let i = 0; i < frame.length; i++) {
          const a = Math.abs(frame[i]);
          if (a > peak) peak = a;
        }
        recentPeak = peak;
        frameCounter++;
        if (frameCounter % 4 !== 0) return;
        if (opts.shouldLogFrames && !opts.shouldLogFrames()) return;
        let sumSq = 0;
        for (let i = 0; i < frame.length; i++) {
          sumSq += frame[i] * frame[i];
        }
        const rms = Math.sqrt(sumSq / frame.length);
        log('[audio-state] vad-frame',
          `peak=${peak.toFixed(4)}`,
          `rms=${rms.toFixed(4)}`,
          `p_speech=${(probabilities?.isSpeech ?? -1).toFixed(3)}`);
      },
      onSpeechRealStart: () => {},
      preSpeechPadMs: 0,
      submitUserSpeechOnPause: false,
      workletOptions: {},
    })]);

    phase('MicVAD.new resolved');
    detachTrackListener();
    // Stop-during-warmup race: stop() OR the track-ended path bumped
    // startGen while we were awaiting MicVAD.new(). The just-resolved
    // inst is orphaned — destroy it immediately and DO NOT store as
    // activeVad. Without this, the resolved inst leaks until the next
    // call's stream-identity check happens to clean it up.
    if (myGen !== startGen) {
      phase(trackEnded
        ? 'start superseded by track-ended — destroying orphan'
        : 'start superseded by stop — destroying orphan');
      try { await inst.destroy(); } catch { /* noop */ }
      return false;
    }
    activeVad = {
      inst,
      micStream,
      speechActive: false,
      startListeners: new Set(),
      endListeners: new Set(),
    };
    phase('started (model=legacy)');
    // Flush the [micvad-trace] buffer on success when the call took
    // >2s — diagnostic for warm-cache slowness. Skip for fast cases
    // to avoid log spam.
    try {
      const buf: string[] | undefined = (typeof window !== 'undefined') ? (window as any).__MICVAD_TRACE_BUF__ : undefined;
      if (buf && buf.length) {
        // Only flush if any phase took >500ms — read the last line's
        // ms delta. Cheap heuristic; tighten later if needed.
        const lastLine = buf[buf.length - 1] || '';
        const m = lastLine.match(/\+(\d+)ms/);
        const totalMs = m ? Number(m[1]) : 0;
        if (totalMs > 2000) {
          for (const line of buf) log(line);
        }
        (window as any).__MICVAD_TRACE_BUF__ = [];
      }
    } catch { /* noop */ }
    return true;
  } catch (e: any) {
    detachTrackListener();
    phase(`MicVAD.new failed: ${e?.message}`);
    // Flush the [micvad-trace] buffer through log() so the on-page
    // debug panel captures the per-phase timing — bare console.log
    // calls inside the patched vad-web bundle don't reach the panel.
    // Bundle's _trace() pushes to window.__MICVAD_TRACE_BUF__; we
    // read+clear here on watchdog fire.
    try {
      const buf: string[] | undefined = (typeof window !== 'undefined') ? (window as any).__MICVAD_TRACE_BUF__ : undefined;
      if (buf && buf.length) {
        for (const line of buf) log(line);
        (window as any).__MICVAD_TRACE_BUF__ = [];
      }
    } catch { /* noop */ }
    return false;
  }
}

/** Stop the VAD session — destroys the MicVAD instance and clears
 *  state. Idempotent. v0.424: refcount removed (see activeVad
 *  docstring); every stop() tears down.
 *
 *  Bumping startGen handles the in-flight-start race: a pending
 *  MicVAD.new will see it on resolution, destroy itself, and skip
 *  becoming activeVad. Without this bump, a hangup-during-warmup
 *  leaves the resolved inst orphaned (smoke caught this v0.424). */
export async function stop(): Promise<void> {
  startGen++;
  recentPeak = 0;  // see recentPeak declaration — reset so a closed call's last peak doesn't gate the next call's first fire
  if (!activeVad) return;
  const handle = activeVad;
  activeVad = null;
  try { await handle.inst.destroy(); } catch (e: any) {
    log('[speechVad] destroy threw:', e?.message);
  }
}

/** Subscribe to speech-start events. Returns an unsubscribe handle.
 *  No-op (returns a no-op unsub) when VAD is not running — callers
 *  should still attach the subscription up front; once start() runs
 *  and produces an activeVad, future-tense subscribers won't re-attach
 *  retroactively, so attach BEFORE awaiting start(). */
export function onSpeechStart(cb: () => void): Unsubscribe {
  if (!activeVad) return () => {};
  activeVad.startListeners.add(cb);
  return () => { activeVad?.startListeners.delete(cb); };
}

/** Subscribe to speech-end events. */
export function onSpeechEnd(cb: () => void): Unsubscribe {
  if (!activeVad) return () => {};
  activeVad.endListeners.add(cb);
  return () => { activeVad?.endListeners.delete(cb); };
}

/** Synchronous read of the current speech-active flag. False when no
 *  VAD is running, when VAD is loading, or when the model says
 *  "currently not speech." Per-frame use is fine — this is just a
 *  Boolean read, no model invocation. */
export function isSpeechActive(): boolean {
  return !!activeVad?.speechActive;
}

/** Synchronous read of the most-recent processed frame's peak amplitude
 *  (max abs sample, 0..1 range). Returns 0 when no frames have been
 *  processed yet OR after speechVad.stop() resets the cache. Used by
 *  BargeDetector's optional minPeak gate to filter out post-AEC residual
 *  agent voice (peak 0.05 typical) from real user speech (peak 0.3+)
 *  even when both produce high p_speech values from Silero. */
export function getRecentPeak(): number {
  return recentPeak;
}

// ── Test hooks ────────────────────────────────────────────────────────
//
// Unit tests inject a stub vad-web module via setVadLibForTests so we
// don't need a real WebAssembly/AudioWorklet runtime to exercise the
// adapter logic. Same shape as the production module — start/stop/
// destroy + the onSpeechStart/End callbacks fired from the harness.

/** @internal — test-only override of the dynamic-imported vad-web module. */
export function setVadLibForTests(stub: any | null): void {
  vadLib = stub;
  supportProbed = stub ? true : null;
}

/** @internal — test-only override of the audio context. start() will use
 *  this instead of audioPlatform.getSharedAudioCtx(). */
export function setAudioCtxForTests(ctx: AudioContext | null): void {
  testCtxOverride = ctx;
}

/** @internal — test-only reset of all module-level state. */
export function resetForTests(): void {
  activeVad = null;
  vadLib = null;
  supportProbed = null;
  testCtxOverride = null;
  startGen = 0;
}
