/**
 * @fileoverview VadSource selection for the unified BargeDetector.
 *
 * `chooseVadStrategy()` returns 'bridge' by default everywhere, with
 * per-user / per-call overrides via URL param `?vad=client|bridge` and
 * the localStorage-backed call-mode-menu setting (Auto / Client / Bridge).
 *
 * History:
 *   - Pre-2026-05-09 the default was per-device (iOS=client, others=
 *     bridge). The split was driven by client-side Silero working on
 *     iOS at normal volume + Mac client-side ONNX cold-start being
 *     structurally broken (microsoft/onnxruntime#19177). After
 *     2026-05-09 iPhone speakerphone field test confirmed bridge
 *     fires correctly on real speech without false-firing on AEC
 *     residual at normal volume, the default flipped to bridge
 *     everywhere. ClientSideVadSource stays compiled in as the
 *     escape hatch for max-volume / bike conditions where bridge's
 *     single-signal Silero hasn't been verified yet.
 *   - The override row in the call-mode menu is keep-don't-kill —
 *     it lets us A/B compare in real use without redeploying.
 */

import { detectDeviceClass } from '../../voiceTuning.ts';
import { BridgeVadSource, ClientSideVadSource, type VadSource } from './vadSource.ts';

/** Floor applied to the user's barge threshold on the built-in
 *  speaker route. CURRENTLY DISABLED (=0) — full slider range needs
 *  to stay tunable while Jonathan field-tests. Once we have data on
 *  where false fires concentrate at speaker volume, set this to a
 *  positive value (likely 0.5-0.7 range based on AEC residual research)
 *  and re-enable the clamp. The wiring + tests stay so flipping the
 *  constant is a one-line change. */
export const SPEAKER_BARGE_THRESHOLD_FLOOR = 0;

export type VadStrategy = 'client' | 'bridge';

/** UI-facing setting value: 'auto' means defer to per-route default. */
export type VadStrategySetting = 'auto' | VadStrategy;

/** localStorage key for the user-facing VAD override (call-mode menu's
 *  Auto / Client / Bridge row). Persistent so iOS-installed PWAs survive
 *  reloads — the URL ?vad= override is unreachable inside an installed
 *  PWA because the browser caches the entry URL. */
const VAD_OVERRIDE_STORAGE_KEY = 'sidekick_vad_override';

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

/** Read the user-facing VAD-strategy override from localStorage.
 *  Returns 'auto' on missing key / invalid value / read error. */
export function getVadStrategyOverrideSetting(): VadStrategySetting {
  if (typeof localStorage === 'undefined') return 'auto';
  try {
    const v = localStorage.getItem(VAD_OVERRIDE_STORAGE_KEY);
    if (v === 'client' || v === 'bridge') return v;
  } catch { /* deny / SSR */ }
  return 'auto';
}

/** Persist the user-facing VAD-strategy override. 'auto' clears the
 *  override entirely (key removed) so chooseVadStrategy() falls back
 *  to the per-route default. */
export function setVadStrategyOverrideSetting(s: VadStrategySetting): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (s === 'auto') localStorage.removeItem(VAD_OVERRIDE_STORAGE_KEY);
    else localStorage.setItem(VAD_OVERRIDE_STORAGE_KEY, s);
  } catch { /* deny / SSR */ }
}

/** Resolve the active strategy.
 *
 *  Precedence: URL `?vad=` (one-off dev/CI testing) > localStorage
 *  setting (PWA-installed user testing) > default (`bridge` everywhere).
 *
 *  Flipped 2026-05-09 from per-device split (iOS=client, others=bridge)
 *  to bridge-default after iPhone speakerphone field test confirmed
 *  bridge-side Silero correctly fires on real speech and doesn't
 *  false-fire on AEC residual at normal volume. Client path stays
 *  reachable via `?vad=client` for max-volume / bike conditions where
 *  bridge multi-signal validation isn't shipped yet. Toggleable
 *  abstraction means the client code remains compiled in; deletion
 *  is a separate cleanup gated on a week of bridge-default field use. */
export function chooseVadStrategy(): VadStrategy {
  const urlOverride = getVadStrategyOverride();
  if (urlOverride) return urlOverride;
  const settingOverride = getVadStrategyOverrideSetting();
  if (settingOverride !== 'auto') return settingOverride;
  return 'bridge';
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
