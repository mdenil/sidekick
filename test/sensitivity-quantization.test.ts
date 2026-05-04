/**
 * Unit tests for the sensitivity↔threshold mapping in settings.ts.
 *
 * Specifically covers the quantization fix Jonathan flagged 2026-05-04:
 * the slider on reload was showing values like "61%" because the
 * stored float threshold didn't round-trip cleanly through the
 * step-5 percentage display. The fix in v0.421 rounds
 * thresholdToSensitivity to nearest step-5 so all reloads land on a
 * clean integer and the slider's `step="5"` attribute matches the
 * display value.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  thresholdToSensitivity,
  sensitivityToThreshold,
} from '../src/settings.ts';

describe('sensitivity ↔ threshold mapping', () => {
  it('thresholdToSensitivity always returns multiples of 5', () => {
    // Sample many points across the slider range (default mac scale
    // is 0.012-0.050; step-5 thresholds should land at 5/10/.../100).
    const samples = [0.012, 0.015, 0.018, 0.020, 0.025, 0.030, 0.035, 0.040, 0.045, 0.050];
    for (const t of samples) {
      const s = thresholdToSensitivity(t);
      assert.equal(s % 5, 0, `threshold=${t} → sensitivity=${s} not divisible by 5`);
    }
  });

  it('thresholdToSensitivity clamps at 0 / 100', () => {
    assert.equal(thresholdToSensitivity(0), 100);
    assert.equal(thresholdToSensitivity(1), 0);
    assert.equal(thresholdToSensitivity(-99), 100);
    assert.equal(thresholdToSensitivity(99), 0);
  });

  it('round-trip is stable on canonical step-5 values', () => {
    // Going from a step-5 sensitivity → threshold → back to sensitivity
    // should land on the same step-5 value (no drift on reload).
    for (let s = 0; s <= 100; s += 5) {
      const t = sensitivityToThreshold(s);
      const back = thresholdToSensitivity(t);
      assert.equal(back, s, `s=${s}% → t=${t} → back=${back}% (drift)`);
    }
  });

  it('non-step-5 stored thresholds snap to nearest step-5 on read', () => {
    // The exact bug Jonathan saw: a stored threshold that maps to
    // ~61% (not 60% or 65%). The fix rounds to nearest step-5 so the
    // slider always shows a clean number.
    // Pick a threshold that would map to ~61% on the default scale:
    // sensitivity 61% means we want the threshold ~39% of the way
    // from max toward min on the device's slider scale. Whatever the
    // exact value, the rounded output must be in {0, 5, 10, …, 100}.
    const fuzzedThresholds = [0.0123, 0.0287, 0.0314, 0.0419, 0.0488];
    for (const t of fuzzedThresholds) {
      const s = thresholdToSensitivity(t);
      assert.equal(s % 5, 0, `non-aligned threshold=${t} → sensitivity=${s} should snap to step-5`);
    }
  });

  it('sensitivityToThreshold + thresholdToSensitivity are monotonic', () => {
    // Higher sensitivity → lower threshold (more sensitive = fires
    // on quieter audio). Inverse mapping should preserve order.
    let prevThr = 1;
    for (let s = 0; s <= 100; s += 5) {
      const t = sensitivityToThreshold(s);
      assert.ok(t <= prevThr, `monotonicity broken at s=${s}: prev=${prevThr} now=${t}`);
      prevThr = t;
    }
  });
});
