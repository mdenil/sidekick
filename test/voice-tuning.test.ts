/**
 * Guards the per-device BargeDetector anti-echo tuning. The 2026-06-10
 * self-barge regression happened because one barge path (turnbased)
 * built a bare BargeDetector and silently skipped the iOS calibration —
 * both paths now spread getBargeDetectorTuning(); these tests pin the
 * profile values that calibration work measured.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getBargeDetectorTuning, DEVICE_DEFAULTS } from '../src/voiceTuning.ts';

describe('getBargeDetectorTuning', () => {
  it('iOS gets the full anti-echo profile (warmup + sustained speech + peak gate)', () => {
    const t = getBargeDetectorTuning('ios');
    assert.equal(t.warmupMs, 1500);
    assert.equal(t.minSpeechMs, 600);
    assert.equal(t.minPeak, 0.15);
  });

  it('desktop classes leave detector defaults (no peak gate)', () => {
    for (const cls of ['mac', 'linux', 'windows'] as const) {
      const t = getBargeDetectorTuning(cls);
      assert.equal(t.warmupMs, undefined, cls);
      assert.equal(t.minSpeechMs, undefined, cls);
      assert.equal(t.minPeak, undefined, cls);
    }
  });

  it('covers every device class without throwing', () => {
    for (const cls of Object.keys(DEVICE_DEFAULTS) as Array<keyof typeof DEVICE_DEFAULTS>) {
      const t = getBargeDetectorTuning(cls);
      assert.equal(typeof t, 'object');
    }
  });
});
