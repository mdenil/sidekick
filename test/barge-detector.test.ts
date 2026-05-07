/**
 * Unit tests for BargeDetector — the unified barge-in detector.
 *
 * Strategy: real wall-clock time (no Date.now mocking) with tight
 * frameMs (5 ms) and short cooldownMs / warmupMs so each test runs in
 * tens of milliseconds. The detector's setInterval fires at real time;
 * we advance via real `await sleep(...)`. The Silero VAD is replaced
 * with a stub via speechVad's existing test hooks, and per-tick speech-
 * active is driven by setSpeechActiveOverrideForTests.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  BargeDetector,
  setSpeechActiveOverrideForTests,
} from '../src/audio/shared/bargeDetector.ts';
import { FakeVadSource } from '../src/audio/shared/vadSource.ts';
import * as speechVad from '../src/audio/shared/speechVad/index.ts';

// ─── Mocks ────────────────────────────────────────────────────────────

const stubAudioCtx: any = { state: 'running', currentTime: 0 };
const stubMicStream: any = { getAudioTracks: () => [] };

/** Minimal MicVAD stub — speechVad calls .new() on first start, then
 *  .destroy() on the last stop(). The detector reads
 *  isSpeechActive() through the override hook so this stub doesn't
 *  need to drive that itself. */
const vadStub = {
  MicVAD: {
    new: async (_opts: any) => ({ destroy: async () => {} }),
  },
};

beforeEach(() => {
  speechVad.resetForTests();
  speechVad.setVadLibForTests(vadStub);
  speechVad.setAudioCtxForTests(stubAudioCtx);
  setSpeechActiveOverrideForTests(() => false);
});

afterEach(async () => {
  setSpeechActiveOverrideForTests(null);
  speechVad.resetForTests();
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const FRAME_MS = 5;  // tight loop for fast tests

// ─── Tests ────────────────────────────────────────────────────────────

describe('BargeDetector', () => {
  it('does not fire when isPlayingCb returns false', async () => {
    let fires = 0;
    const det = new BargeDetector();
    setSpeechActiveOverrideForTests(() => true);
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => false,
      isEnabledCb: () => true,
      onFire: () => { fires++; },
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 50,
      silentFire: true,
    });
    await sleep(80);
    await det.stop();
    assert.equal(fires, 0);
  });

  it('does not fire when isEnabledCb returns false', async () => {
    let fires = 0;
    const det = new BargeDetector();
    setSpeechActiveOverrideForTests(() => true);
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => true,
      isEnabledCb: () => false,
      onFire: () => { fires++; },
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 50,
      silentFire: true,
    });
    await sleep(80);
    await det.stop();
    assert.equal(fires, 0);
  });

  it('does not fire when speech is inactive', async () => {
    let fires = 0;
    const det = new BargeDetector();
    setSpeechActiveOverrideForTests(() => false);
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => true,
      isEnabledCb: () => true,
      onFire: () => { fires++; },
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 50,
      silentFire: true,
    });
    await sleep(80);
    await det.stop();
    assert.equal(fires, 0);
  });

  it('fires once when speech goes active during playback', async () => {
    let fires = 0;
    let speechOn = false;
    const det = new BargeDetector();
    setSpeechActiveOverrideForTests(() => speechOn);
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => true,
      isEnabledCb: () => true,
      onFire: () => { fires++; },
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 200,  // long enough to suppress within the test window
      silentFire: true,
    });
    await sleep(20);
    speechOn = true;
    await sleep(20);
    await det.stop();
    assert.equal(fires, 1);
  });

  it('respects the warmup mute window', async () => {
    let fires = 0;
    const det = new BargeDetector();
    setSpeechActiveOverrideForTests(() => true);
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => true,
      isEnabledCb: () => true,
      onFire: () => { fires++; },
      warmupMs: 50,
      frameMs: FRAME_MS,
      cooldownMs: 200,
      silentFire: true,
    });
    await sleep(30);
    assert.equal(fires, 0, 'should still be in warmup mute');
    await sleep(60);
    await det.stop();
    assert.equal(fires, 1);
  });

  it('honors cooldown — does not re-fire within cooldown window', async () => {
    let fires = 0;
    const det = new BargeDetector();
    setSpeechActiveOverrideForTests(() => true);  // sustained speech
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => true,
      isEnabledCb: () => true,
      onFire: () => { fires++; },
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 100,
      silentFire: true,
    });
    await sleep(20);
    assert.equal(fires, 1);
    await sleep(60);
    assert.equal(fires, 1, 'mid-cooldown — still one fire');
    await sleep(80);
    await det.stop();
    assert.equal(fires, 2, 'past cooldown — fires again');
  });

  it('re-arms (clears cooldown + warmup) when isPlayingCb flips false', async () => {
    let fires = 0;
    let playing = true;
    const det = new BargeDetector();
    setSpeechActiveOverrideForTests(() => true);
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => playing,
      isEnabledCb: () => true,
      onFire: () => { fires++; },
      warmupMs: 30,
      frameMs: FRAME_MS,
      cooldownMs: 5000,
      silentFire: true,
    });
    await sleep(60);
    assert.equal(fires, 1);
    playing = false;
    await sleep(20);
    playing = true;
    // Now we should have to wait warmup again.
    await sleep(20);
    assert.equal(fires, 1, 'in warmup of new turn — no fire');
    await sleep(40);
    await det.stop();
    assert.equal(fires, 2);
  });

  it('stop() is idempotent', async () => {
    const det = new BargeDetector();
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => false,
      isEnabledCb: () => true,
      onFire: () => {},
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 50,
      silentFire: true,
    });
    await det.stop();
    await det.stop();
    await det.stop();
    assert.equal(det.isRunning(), false);
  });

  it('start() replaces a previous start (not additive)', async () => {
    let firesB = 0;
    const det = new BargeDetector();
    setSpeechActiveOverrideForTests(() => true);
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => true,
      isEnabledCb: () => true,
      onFire: () => {},
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 5000,
      silentFire: true,
    });
    // Restart immediately with a different onFire.
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => true,
      isEnabledCb: () => true,
      onFire: () => { firesB++; },
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 5000,
      silentFire: true,
    });
    await sleep(20);
    await det.stop();
    assert.ok(firesB >= 1, 'new onFire should be the active callback');
    assert.equal(det.isRunning(), false);
  });

  it('onFire throwing does not break the loop', async () => {
    let fires = 0;
    const det = new BargeDetector();
    setSpeechActiveOverrideForTests(() => true);
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => true,
      isEnabledCb: () => true,
      onFire: () => { fires++; throw new Error('intentional'); },
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 50,
      silentFire: true,
    });
    await sleep(20);
    assert.equal(fires, 1);
    await sleep(80);
    await det.stop();
    assert.ok(fires >= 2, 'loop should survive onFire throw and re-fire after cooldown');
  });

  it('isRunning reflects loop state', async () => {
    const det = new BargeDetector();
    assert.equal(det.isRunning(), false);
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => false,
      isEnabledCb: () => true,
      onFire: () => {},
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 50,
      silentFire: true,
    });
    assert.equal(det.isRunning(), true);
    await det.stop();
    assert.equal(det.isRunning(), false);
  });

  it('VadSource DI: fires when fake.setSpeechActive(true) and not before', async () => {
    // beforeEach sets the speechActive override to () => false; clear it so
    // the DI path actually consults vadSource.isSpeechActive().
    setSpeechActiveOverrideForTests(null);
    let fires = 0;
    const fake = new FakeVadSource();
    const det = new BargeDetector();
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => true,
      isEnabledCb: () => true,
      onFire: () => { fires++; },
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 200,
      silentFire: true,
      vadSource: fake,
    });
    // VadSource start() was awaited — fake reports started.
    assert.equal(fake.isStarted(), true);
    // No fire while speech is silent.
    await sleep(20);
    assert.equal(fires, 0);
    // Drive synthetic speech.
    fake.setSpeechActive(true);
    await sleep(20);
    assert.equal(fires, 1);
    await det.stop();
    // VadSource.stop() was called on detector teardown.
    assert.equal(fake.isStarted(), false);
  });

  it('VadSource DI: peak gate suppresses fire when fake peak below minPeak', async () => {
    setSpeechActiveOverrideForTests(null);
    let fires = 0;
    const fake = new FakeVadSource();
    const det = new BargeDetector();
    fake.setSpeechActive(true);
    fake.setPeak(0.05);  // below threshold
    await det.start({
      micStream: stubMicStream,
      isPlayingCb: () => true,
      isEnabledCb: () => true,
      onFire: () => { fires++; },
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 200,
      silentFire: true,
      vadSource: fake,
      minPeak: 0.15,
    });
    await sleep(30);
    assert.equal(fires, 0, 'peak below minPeak should suppress');
    fake.setPeak(0.4);  // above threshold
    await sleep(30);
    await det.stop();
    assert.equal(fires, 1, 'peak above minPeak should allow fire');
  });

  it('multiple detectors share the speechVad refcount cleanly', async () => {
    const det1 = new BargeDetector();
    const det2 = new BargeDetector();
    await det1.start({
      micStream: stubMicStream,
      isPlayingCb: () => false,
      isEnabledCb: () => true,
      onFire: () => {},
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 50,
      silentFire: true,
    });
    await det2.start({
      micStream: stubMicStream,
      isPlayingCb: () => false,
      isEnabledCb: () => true,
      onFire: () => {},
      warmupMs: 0,
      frameMs: FRAME_MS,
      cooldownMs: 50,
      silentFire: true,
    });
    await det1.stop();
    assert.equal(det2.isRunning(), true);
    await det2.stop();
  });
});
