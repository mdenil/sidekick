/**
 * @fileoverview Per-route VadSource selection for the unified
 * BargeDetector. Picks ClientSideVadSource on iOS and BridgeVadSource
 * elsewhere; URL param `?vad=client|bridge` overrides for A/B testing.
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
