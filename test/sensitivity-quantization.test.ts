/**
 * Unit tests for the sensitivity↔VAD threshold mapping in settings.ts.
 *
 * Slider position 0..100% maps inversely to Silero
 * `positiveSpeechThreshold` 0..1. Round-trip must be stable on step-5
 * values so the slider doesn't drift to "61%" on reload.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  vadThresholdToSensitivity,
  sensitivityToVadThreshold,
} from '../src/settings.ts';

describe('sensitivity ↔ VAD threshold mapping', () => {
  it('vadThresholdToSensitivity always returns multiples of 5', () => {
    const samples = [0.0, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
    for (const t of samples) {
      const s = vadThresholdToSensitivity(t);
      assert.equal(s % 5, 0, `threshold=${t} → sensitivity=${s} not divisible by 5`);
    }
  });

  it('vadThresholdToSensitivity clamps at 0 / 100', () => {
    assert.equal(vadThresholdToSensitivity(0), 100);
    assert.equal(vadThresholdToSensitivity(1), 0);
    assert.equal(vadThresholdToSensitivity(-99), 100);
    assert.equal(vadThresholdToSensitivity(99), 0);
  });

  it('round-trip is stable on canonical step-5 values', () => {
    // Skip 0% — that's the kill-switch (bargeIn=false), not a threshold
    // value. The mapping function clamps sens to ≥1 internally.
    for (let s = 5; s <= 100; s += 5) {
      const t = sensitivityToVadThreshold(s);
      const back = vadThresholdToSensitivity(t);
      assert.equal(back, s, `s=${s}% → t=${t} → back=${back}% (drift)`);
    }
  });

  it('100% sensitivity = threshold 0; 50% = 0.5; default 50% threshold = 50% sens', () => {
    assert.equal(sensitivityToVadThreshold(100), 0);
    assert.equal(sensitivityToVadThreshold(50), 0.5);
    assert.equal(vadThresholdToSensitivity(0.5), 50);
  });

  it('mapping is monotonic (higher sens = lower threshold)', () => {
    let prevThr = 1;
    for (let s = 1; s <= 100; s += 5) {
      const t = sensitivityToVadThreshold(s);
      assert.ok(t <= prevThr, `monotonicity broken at s=${s}: prev=${prevThr} now=${t}`);
      prevThr = t;
    }
  });
});
