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
import { detectDeviceClass, DEVICE_DEFAULTS } from '../../voiceTuning.ts';

let detector: BargeDetector | null = null;

export function start(
  micStream: MediaStream,
  isPlaying: () => boolean,
  onFire: () => void,
): void {
  stop();
  const s: any = settings.get();
  // Slider position 0% set bargeIn=false — that's the kill switch. Skip
  // detector creation entirely so we don't ref-inc Silero, don't run
  // the per-frame loop, and don't waste CPU.
  if (!s.bargeIn) {
    log('[realtime-barge] skipped — barge disabled (slider 0% / bargeIn=false)');
    return;
  }
  const threshold = typeof s.bargeVadThreshold === 'number' ? s.bargeVadThreshold : 0.5;
  // Per-device warmup + minSpeechMs overrides — iOS bumps both because
  // Apple's AEC needs ~1 s to settle at TTS-start and Silero would
  // otherwise fire on the residual. Other platforms get BargeDetector
  // defaults (500 ms / 400 ms).
  const dev = DEVICE_DEFAULTS[detectDeviceClass()];
  log('[audio-state] realtimeBarge.start',
    `bargeIn=true`,
    `bargeVadThreshold=${threshold}`,
    `warmupMs=${dev.bargeWarmupMs ?? 'default'}`,
    `minSpeechMs=${dev.bargeMinSpeechMs ?? 'default'}`);
  detector = new BargeDetector();
  void detector.start({
    micStream,
    isPlayingCb: isPlaying,
    isEnabledCb: () => !!(settings.get() as any).bargeIn,
    onFire,
    positiveSpeechThreshold: threshold,
    warmupMs: dev.bargeWarmupMs,
    minSpeechMs: dev.bargeMinSpeechMs,
  });
  log('[realtime-barge] started');
}

export function stop(): void {
  if (detector) {
    void detector.stop();
    detector = null;
  }
}
