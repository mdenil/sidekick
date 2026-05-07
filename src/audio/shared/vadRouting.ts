/**
 * @fileoverview Per-route barge policy: VadSource selection AND
 * threshold floor for the unified BargeDetector.
 *
 * VadSource selection picks ClientSideVadSource on iOS and
 * BridgeVadSource elsewhere; URL param `?vad=client|bridge` overrides
 * for A/B testing.
 *
 * Threshold floor clamps the user's barge sensitivity setting up to
 * a minimum value when the route is hostile (iOS speakerphone).
 * Slider position still drives behavior, but the floor rejects the
 * band where false fires concentrate against AEC residual + TTS
 * bleed.
 *
 * RATIONALE (see notes_session_2026_05_06_barge.md):
 *   - iOS: client-side Silero+vad-web works at normal volume after
 *     Phase-0 tacticals + halt-event fix. Speakerphone max-volume is
 *     a known hardware-coupling limit no software fully closes.
 *   - Mac/desktop: client-side ONNX Runtime Web cold-start is
 *     structurally broken (microsoft/onnxruntime#19177 — InferenceSession
 *     load times out >15s). Bridge-side Silero (Python torch) loads
 *     once at process start, works regardless of client device.
 *
 * KILL CRITERION (2026-06-03): collapse optionality based on field
 * data. Single winner → delete loser implementation; per-route splits
 * stay → delete the override flag, lock routing policy.
 */

import { detectDeviceClass } from '../../voiceTuning.ts';
import { BridgeVadSource, ClientSideVadSource, type VadSource } from './vadSource.ts';

/** Floor applied to the user's barge threshold when the active output
 *  route is the device's built-in speaker. At normal speaker volume,
 *  AEC residual + TTS bleed land Silero confidence in the 0.4-0.6
 *  range; this floor rejects that band so false fires don't dominate
 *  the call. Starting value — tune with field data. */
export const SPEAKER_BARGE_THRESHOLD_FLOOR = 0.65;

export type VadStrategy = 'client' | 'bridge';

/** Returns the URL-param override if present and valid, else null. */
export function getVadStrategyOverride(): VadStrategy | null {
  if (typeof window === 'undefined') return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('vad');
    if (v === 'client' || v === 'bridge') return v;
  } catch {
    /* SSR / non-browser env */
  }
  return null;
}

/** Resolve the active strategy: override > per-route default. */
export function chooseVadStrategy(): VadStrategy {
  const override = getVadStrategyOverride();
  if (override) return override;
  return detectDeviceClass() === 'ios' ? 'client' : 'bridge';
}

/** Construct a VadSource for the active strategy. Optionally pass an
 *  explicit strategy (used by tests + future per-call overrides). */
export function makeVadSource(strategy?: VadStrategy): VadSource {
  const s = strategy ?? chooseVadStrategy();
  return s === 'bridge' ? new BridgeVadSource() : new ClientSideVadSource();
}

/** Compute the effective barge VAD threshold given the user's setting
 *  and the active output route. On the built-in speaker the floor is
 *  enforced (only sensitivities below the floor get clamped); on other
 *  routes the user value passes through unchanged. Pure function for
 *  testability. */
export function effectiveBargeThreshold(
  userThreshold: number,
  onSpeaker: boolean,
): number {
  if (!onSpeaker) return userThreshold;
  return Math.max(userThreshold, SPEAKER_BARGE_THRESHOLD_FLOOR);
}
