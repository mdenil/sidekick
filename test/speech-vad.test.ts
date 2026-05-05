/**
 * @fileoverview Tests for the SpeechVAD adapter — wraps @ricky0123/vad-web
 * MicVAD into a refcounted shared instance with onSpeechStart/End
 * subscriptions and a synchronous isSpeechActive() readout.
 *
 * Same pattern as test/sendword-detector.test.ts: stub the underlying
 * library (the dynamic-imported module is replaced via setVadLibForTests),
 * simulate the speechStart/End callbacks the model would fire, observe the
 * adapter's behavior. No real AudioWorklet, no real WASM.
 *
 * Manual repro (smoke — not automated, requires a real bike or a hard
 * mechanical impulse near the mic):
 *   1. Open call mode in a real device browser (https://&lt;your-host&gt;:3001)
 *   2. Slider at default (50%, mid-sensitivity).
 *   3. Begin a call, wait for the agent to start speaking.
 *   4. Clap hands once, sharply, near the mic. EXPECT: no barge fire
 *      (agent keeps talking). Pre-VAD behavior: barge fired here.
 *   5. Speak normally ("hey, stop"). EXPECT: barge fires within ~150 ms
 *      (Silero's minSpeechMs default).
 *   6. Pull slider to MIN (least sensitive). Repeat clap → still no
 *      fire (RMS doesn't even gate). Speak loudly → fires. RMS still
 *      controls the sensitivity dial; VAD is the discriminator.
 *   7. Pull slider to MAX (most sensitive). Clap → still no fire (VAD
 *      vetoes). The slider's "max sensitivity" used to mean "fires on
 *      any loud transient"; with VAD it means "fires on any speech."
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import * as speechVad from '../src/audio/shared/speechVad/index.ts';

// ── Stub harness ──────────────────────────────────────────────────────
//
// Mimics the @ricky0123/vad-web surface SpeechVAD calls into. start()
// constructs a MicVAD instance — the stub captures the options dict
// (so tests can assert on getStream/audioContext/threshold wiring) and
// exposes fireSpeechStart/End methods that simulate the model's
// callbacks for the adapter's onSpeechStart/End wiring.

let lastInstance: StubMicVAD | null = null;

class StubMicVAD {
  options: any;
  destroyCalls = 0;
  static instancesBuilt = 0;

  constructor(options: any) {
    this.options = options;
    StubMicVAD.instancesBuilt++;
    lastInstance = this;
  }

  static async new(options: any): Promise<StubMicVAD> {
    return new StubMicVAD(options);
  }

  async destroy(): Promise<void> {
    this.destroyCalls++;
  }

  fireSpeechStart(): void { this.options.onSpeechStart?.(); }
  fireSpeechEnd(): void { this.options.onSpeechEnd?.(new Float32Array(0)); }
  fireMisfire(): void { this.options.onVADMisfire?.(); }
}

// Minimal AudioContext stub — speechVad just needs SOMETHING non-null
// to pass through to MicVAD.new. Internal MicVAD construction is faked
// via the StubMicVAD harness, so the real Web Audio API is never used.
const fakeCtx = {} as AudioContext;
const fakeStream = {} as MediaStream;

describe('SpeechVAD adapter', () => {
  beforeEach(() => {
    speechVad.resetForTests();
    speechVad.setVadLibForTests({ MicVAD: StubMicVAD, utils: {} });
    speechVad.setAudioCtxForTests(fakeCtx);
    StubMicVAD.instancesBuilt = 0;
    lastInstance = null;
  });

  afterEach(async () => {
    await speechVad.stop().catch(() => {});
    speechVad.resetForTests();
  });

  it('isSupported returns true when the lib stub is wired', async () => {
    assert.equal(await speechVad.isSupported(), true);
  });

  it('isSupported returns false when the stub is cleared', async () => {
    speechVad.setVadLibForTests(null);
    assert.equal(await speechVad.isSupported(), false);
  });

  it('start() returns false when the adapter cannot find an AudioContext', async () => {
    speechVad.setAudioCtxForTests(null);
    // We also need to clear the platform's shared ctx — easier to just
    // assert the return-false path: with no ctx override, the lib also
    // pulls null and returns false.
    const ok = await speechVad.start(fakeStream);
    assert.equal(ok, false);
  });

  it('start() builds a single MicVAD with caller-supplied stream', async () => {
    const ok = await speechVad.start(fakeStream);
    assert.equal(ok, true);
    assert.equal(StubMicVAD.instancesBuilt, 1);
    assert.ok(lastInstance);
    // The adapter must NOT open a second mic — getStream should return
    // the supplied stream verbatim.
    const out = await lastInstance!.options.getStream();
    assert.equal(out, fakeStream);
    // And the shared AudioContext must be passed through so the worklet
    // attaches to the gesture-bound ctx.
    assert.equal(lastInstance!.options.audioContext, fakeCtx);
  });

  it('passes Silero tuning knobs to MicVAD', async () => {
    await speechVad.start(fakeStream, {
      positiveSpeechThreshold: 0.7,
      negativeSpeechThreshold: 0.4,
      redemptionMs: 800,
      minSpeechMs: 200,
    });
    assert.equal(lastInstance!.options.positiveSpeechThreshold, 0.7);
    assert.equal(lastInstance!.options.negativeSpeechThreshold, 0.4);
    assert.equal(lastInstance!.options.redemptionMs, 800);
    assert.equal(lastInstance!.options.minSpeechMs, 200);
  });

  it('isSpeechActive flips true on speechStart, false on speechEnd', async () => {
    await speechVad.start(fakeStream);
    assert.equal(speechVad.isSpeechActive(), false);
    lastInstance!.fireSpeechStart();
    assert.equal(speechVad.isSpeechActive(), true);
    lastInstance!.fireSpeechEnd();
    assert.equal(speechVad.isSpeechActive(), false);
  });

  it('onSpeechStart subscribers fire on each speech-start event', async () => {
    await speechVad.start(fakeStream);
    let count = 0;
    const unsub = speechVad.onSpeechStart(() => { count++; });
    lastInstance!.fireSpeechStart();
    lastInstance!.fireSpeechEnd();
    lastInstance!.fireSpeechStart();
    assert.equal(count, 2);
    unsub();
    lastInstance!.fireSpeechStart();
    assert.equal(count, 2);  // no new fire after unsub
  });

  it('onSpeechEnd subscribers fire on each speech-end event', async () => {
    await speechVad.start(fakeStream);
    let count = 0;
    speechVad.onSpeechEnd(() => { count++; });
    lastInstance!.fireSpeechStart();
    lastInstance!.fireSpeechEnd();
    lastInstance!.fireSpeechStart();
    lastInstance!.fireSpeechEnd();
    assert.equal(count, 2);
  });

  it('onVADMisfire drops the speech-active flag without firing speechEnd', async () => {
    await speechVad.start(fakeStream);
    let endCount = 0;
    speechVad.onSpeechEnd(() => { endCount++; });
    lastInstance!.fireSpeechStart();
    assert.equal(speechVad.isSpeechActive(), true);
    lastInstance!.fireMisfire();
    assert.equal(speechVad.isSpeechActive(), false);
    // onVADMisfire intentionally does NOT call onSpeechEnd subscribers
    // — vad-web's contract is "speech was too short, drop it silently."
    assert.equal(endCount, 0);
  });

  it('refcounts: second start() does not build a second MicVAD', async () => {
    await speechVad.start(fakeStream);
    await speechVad.start(fakeStream);
    assert.equal(StubMicVAD.instancesBuilt, 1);
  });

  it('every stop() destroys the active MicVAD (refcount removed in v0.424)', async () => {
    // v0.424 removed the multi-caller refcount. Same-stream re-entrant
    // start() reuses the single activeVad without rebuild, but the
    // FIRST stop() tears it down — there's no "wait for last caller."
    // This matches the production lifecycle: BargeDetector is the only
    // caller and owns lifecycle exclusively.
    await speechVad.start(fakeStream);
    await speechVad.start(fakeStream);  // same-stream, reuses
    assert.equal(StubMicVAD.instancesBuilt, 1);
    await speechVad.stop();
    assert.equal(lastInstance!.destroyCalls, 1);
  });

  it('isSpeechActive returns false when no VAD is running', async () => {
    assert.equal(speechVad.isSpeechActive(), false);
    await speechVad.start(fakeStream);
    lastInstance!.fireSpeechStart();
    assert.equal(speechVad.isSpeechActive(), true);
    await speechVad.stop();
    assert.equal(speechVad.isSpeechActive(), false);
  });

  it('start() returns false when the lib reports a load failure', async () => {
    // Simulate the dynamic-import path failing — adapter must fall
    // through to the false return so callers know to use RMS-only.
    speechVad.setVadLibForTests(null);
    assert.equal(await speechVad.start(fakeStream), false);
  });

  it('subscribers attached AFTER start() receive future events', async () => {
    await speechVad.start(fakeStream);
    let count = 0;
    speechVad.onSpeechStart(() => { count++; });
    lastInstance!.fireSpeechStart();
    assert.equal(count, 1);
  });
});
