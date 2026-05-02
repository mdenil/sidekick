/**
 * @fileoverview Tests for the shared BargeWindow detector — the
 * sliding N-of-K hot-frames algorithm both audio modes use (turn-
 * based directly via this module; realtime-via-bridge runs the
 * Python equivalent).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BargeWindow } from '../src/audio/shared/barge.ts';

const THRESHOLD = 0.20;

describe('BargeWindow', () => {
  it('does not fire before the window is full', () => {
    const w = new BargeWindow();  // defaults: 5 frames, 4 hot
    assert.equal(w.push(0.5, THRESHOLD), false);  // 1
    assert.equal(w.push(0.5, THRESHOLD), false);  // 2
    assert.equal(w.push(0.5, THRESHOLD), false);  // 3
    assert.equal(w.push(0.5, THRESHOLD), false);  // 4
  });

  it('fires when the 5th frame puts the window over the bar (4 hot of 5)', () => {
    const w = new BargeWindow();
    w.push(0.5, THRESHOLD);  // 1 hot
    w.push(0.5, THRESHOLD);  // 2 hot
    w.push(0.5, THRESHOLD);  // 3 hot
    w.push(0.05, THRESHOLD); // 4: not hot — window so far: 3 hot
    assert.equal(w.push(0.5, THRESHOLD), true);  // 5: hot — window: 4 hot of 5 → fire
  });

  it('does not fire on a single-burst-then-quiet pattern', () => {
    const w = new BargeWindow();
    w.push(0.05, THRESHOLD);
    w.push(0.05, THRESHOLD);
    w.push(0.5, THRESHOLD);  // brief spike (wind gust)
    w.push(0.05, THRESHOLD);
    assert.equal(w.push(0.05, THRESHOLD), false);  // window: 1 hot of 5
  });

  it('does not fire on two-burst pattern (still under 4 hot)', () => {
    const w = new BargeWindow();
    w.push(0.5, THRESHOLD);
    w.push(0.05, THRESHOLD);
    w.push(0.5, THRESHOLD);
    w.push(0.05, THRESHOLD);
    assert.equal(w.push(0.05, THRESHOLD), false);  // 2 hot of 5
  });

  it('slides the window — earlier hot frames age out', () => {
    const w = new BargeWindow();
    // 4 consecutive hot then 5 consecutive quiet → no fire after window slides past
    w.push(0.5, THRESHOLD);
    w.push(0.5, THRESHOLD);
    w.push(0.5, THRESHOLD);
    w.push(0.5, THRESHOLD);
    assert.equal(w.push(0.05, THRESHOLD), true);  // 4 hot, 1 quiet → fires
    assert.equal(w.push(0.05, THRESHOLD), false); // 3 hot, 2 quiet
    assert.equal(w.push(0.05, THRESHOLD), false); // 2 hot, 3 quiet
    assert.equal(w.push(0.05, THRESHOLD), false); // 1 hot, 4 quiet
    assert.equal(w.push(0.05, THRESHOLD), false); // 0 hot, 5 quiet
  });

  it('respects custom windowSize + requiredHot', () => {
    const w = new BargeWindow({ windowSize: 3, requiredHot: 2 });
    assert.equal(w.push(0.5, THRESHOLD), false);  // 1 of 3
    assert.equal(w.push(0.05, THRESHOLD), false); // 2 of 3, 1 hot
    assert.equal(w.push(0.5, THRESHOLD), true);   // 3 of 3, 2 hot → fire
  });

  it('respects live threshold updates per push', () => {
    const w = new BargeWindow({ windowSize: 3, requiredHot: 2 });
    // Same peak readings but the threshold rises mid-window — fewer hot
    w.push(0.3, 0.20);  // 0.3 > 0.20 → hot
    w.push(0.3, 0.40);  // 0.3 > 0.40 → not hot
    assert.equal(w.push(0.3, 0.40), false);  // 0.3 > 0.40 → not hot; 1 of 3 hot
  });

  it('clear() drops the window', () => {
    const w = new BargeWindow();
    w.push(0.5, THRESHOLD);
    w.push(0.5, THRESHOLD);
    w.push(0.5, THRESHOLD);
    w.push(0.5, THRESHOLD);
    w.clear();
    assert.equal(w.push(0.5, THRESHOLD), false);  // 1 of 5 again
    assert.equal(w.push(0.5, THRESHOLD), false);  // 2 of 5
    assert.equal(w.push(0.5, THRESHOLD), false);  // 3 of 5
    assert.equal(w.push(0.5, THRESHOLD), false);  // 4 of 5
    assert.equal(w.push(0.5, THRESHOLD), true);   // 5 of 5 → fire
  });

  it('peak exactly equal to threshold is NOT hot (strict >)', () => {
    const w = new BargeWindow({ windowSize: 3, requiredHot: 1 });
    assert.equal(w.push(THRESHOLD, THRESHOLD), false);
    assert.equal(w.push(THRESHOLD, THRESHOLD), false);
    assert.equal(w.push(THRESHOLD, THRESHOLD), false);
  });
});
