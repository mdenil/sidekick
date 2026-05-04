/**
 * @fileoverview Realtime barge wiring — thin glue around the unified
 * `BargeDetector` for WebRTC talk-mode calls. The implementation lives
 * in `audio/shared/bargeDetector.ts`; this module owns nothing but the
 * detector instance and the lifecycle wiring to the WebRTC peer's mic.
 *
 * KEEP THIS FILE BYTE-EQUIVALENT TO `turn-based/turnbased.ts`'s
 * `startBargeLoop`/`stopBargeLoop` (modulo the mic-stream and
 * isPlaying source). Any divergence is a smell — the whole point of
 * BargeDetector is that both modes invoke it identically.
 */

import { log } from '../../util/log.ts';
import { BargeDetector } from '../shared/bargeDetector.ts';
import * as settings from '../../settings.ts';

let detector: BargeDetector | null = null;

export function start(
  micStream: MediaStream,
  isPlaying: () => boolean,
  onFire: () => void,
): void {
  stop();
  detector = new BargeDetector();
  void detector.start({
    micStream,
    isPlayingCb: isPlaying,
    isEnabledCb: () => !!(settings.get() as any).bargeIn,
    onFire,
  });
  log('[realtime-barge] started');
}

export function stop(): void {
  if (detector) {
    void detector.stop();
    detector = null;
  }
}
