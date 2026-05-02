/**
 * @fileoverview Sliding-window barge-in detector — N-of-K hot frames
 * above a peak threshold. Same algorithm classic ran on a Pi for
 * months: 5-frame window, 4 hot required (default), rejects single-
 * burst noise (wind gust, table tap) but catches sustained speech
 * with the inevitable mid-syllable amplitude dips.
 *
 * The audio source is mode-specific (turn-based: PWA-side analyser
 * peaks; future: anywhere with a peak signal). Threshold + warmup
 * stay caller-driven so live settings changes propagate without this
 * module needing to read settings.
 *
 * The Python `audio-bridge/` runs the same algorithm in the realtime
 * mode but as Python — that's a separate codebase, so we don't share
 * code, only intent.
 */

export type BargeWindowOpts = {
  /** Number of recent frames to consider. Default 5. */
  windowSize?: number;
  /** How many frames must exceed threshold to fire. Default 4. */
  requiredHot?: number;
};

export class BargeWindow {
  private window: number[] = [];
  private windowSize: number;
  private requiredHot: number;

  constructor(opts: BargeWindowOpts = {}) {
    this.windowSize = opts.windowSize ?? 5;
    this.requiredHot = opts.requiredHot ?? 4;
  }

  /** Push one peak reading. Returns true when ≥ requiredHot of the
   *  last windowSize readings exceeded `threshold` — i.e. a barge
   *  fire. Caller is responsible for resetting via `clear()` after a
   *  fire if it doesn't want immediate re-fire on the next frame. */
  push(peak: number, threshold: number): boolean {
    const hot = peak > threshold ? 1 : 0;
    this.window.push(hot);
    if (this.window.length > this.windowSize) this.window.shift();
    if (this.window.length < this.windowSize) return false;
    let sum = 0;
    for (const v of this.window) sum += v;
    return sum >= this.requiredHot;
  }

  /** Drop the window. Use on barge-loop start (so prior-state samples
   *  don't carry into a new playback) and after a fire. */
  clear(): void {
    this.window = [];
  }
}
