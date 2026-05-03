/**
 * @fileoverview Device-class voice tuning defaults — initial values for
 * the BargeWindow threshold, keyed off coarse UA-derived device class.
 *
 * Why per-device defaults: the analyser peaks the BargeWindow consumes
 * are floating-point [0,1] amplitudes that vary substantially with the
 * mic + capture path:
 *   - iOS (BT mic, ambient pickup is loud): floor ~0.12, speech ~0.25
 *   - macOS / Linux / Windows (clean USB / built-in): floor ~0.05, speech ~0.20
 *   - Android (moderate, varies by handset): floor ~0.08, speech ~0.20
 *
 * One global default would either fire on iOS BT ambient (too low) or
 * miss soft speech on a desktop USB mic (too high). The table here is
 * a starting point — Jonathan will tune the values from real devices,
 * and a future commit will add an IDB-backed local override store.
 *
 * The settings.bargeThreshold value still exists (slider in the
 * settings panel) and overrides the device default when explicitly
 * set. This module's getBargeThreshold() returns the effective value:
 * device default unless the user has nudged the slider away from the
 * legacy default of 0.10.
 */

import * as settings from './settings.ts';

export type DeviceClass = 'ios' | 'android' | 'mac' | 'linux' | 'windows';

/** Detect the rough device class from the UA string. Coarse on
 *  purpose — we only need enough resolution to pick a row from the
 *  defaults table, not to identify specific hardware. */
export function detectDeviceClass(): DeviceClass {
  if (typeof navigator === 'undefined') return 'linux';
  const ua = navigator.userAgent || '';
  // iPad-as-Mac trick: modern iPadOS reports as Mac. The
  // ontouchend/maxTouchPoints sniff catches it. Order matters — check
  // iOS before Mac.
  if (/iPad|iPhone|iPod/.test(ua)) return 'ios';
  if (/Macintosh/.test(ua)) {
    const isTouchMac = (navigator as any).maxTouchPoints > 1;
    return isTouchMac ? 'ios' : 'mac';
  }
  if (/Android/.test(ua)) return 'android';
  if (/Win/.test(ua)) return 'windows';
  return 'linux';
}

/** Initial BargeWindow threshold by device class.
 *
 *  RECALIBRATED 2026-05-03 from real diag-log data (v0.384 added a
 *  per-tick peak/threshold logger). Previous values assumed speech
 *  peaked at ~0.20 — wrong by 4-5×.
 *
 *  Real Mac (Chrome built-in mic, quiet room) measurements:
 *    floor (silence/ambient): ~0.008
 *    "okay" loud speech:      ~0.03–0.05 peak
 *  → Threshold 0.025 puts the bar above ambient floor (×3) but well
 *    below actual speech (~half), so a single hot frame catches
 *    real speech and the N-of-K window doesn't fire on stray
 *    keyboard taps.
 *
 *  iOS / Android: don't have real data yet; values are guesses
 *  proportionally scaled down from the prior table by the same
 *  factor the Mac calibration revealed (~0.10 / 0.025 = 4×).
 *  Re-tune from device after first iOS field test of v0.385.
 *
 *  Tunable per-row; Jonathan will adjust from real devices.
 */
export const DEVICE_DEFAULTS: Record<DeviceClass, { bargeThreshold: number }> = {
  ios: { bargeThreshold: 0.04 },     // was 0.18 — guess, retune w/ field data
  android: { bargeThreshold: 0.035 }, // was 0.15 — guess
  mac: { bargeThreshold: 0.025 },    // was 0.10 — measured, see comment above
  linux: { bargeThreshold: 0.025 },  // was 0.10 — assume similar to mac built-in
  windows: { bargeThreshold: 0.025 },// was 0.10 — assume similar to mac built-in
};

/** Sentinel for "settings.bargeThreshold has not been moved from the
 *  legacy global default." When the user nudges the slider, settings.ts
 *  writes a different value and getBargeThreshold returns that.
 *  Otherwise the device default wins. */
const LEGACY_GLOBAL_DEFAULT = 0.10;

/** Return the effective BargeWindow threshold for the current device.
 *
 *  Resolution order:
 *    1. If the caller's settings.get().bargeThreshold differs from the
 *       legacy global default 0.10, the user has explicitly set a
 *       value — return that.
 *    2. Else look up DEVICE_DEFAULTS by detectDeviceClass() and return
 *       its bargeThreshold.
 *
 *  Read-through (no caching): the device class can't change at runtime
 *  but settings.bargeThreshold can flip live, so we re-resolve on
 *  every call. Cheap — UA sniff + dictionary lookup. */
export function getBargeThreshold(): number {
  const userVal = Number(settings.get().bargeThreshold);
  if (Number.isFinite(userVal) && userVal !== LEGACY_GLOBAL_DEFAULT) {
    return userVal;
  }
  const cls = detectDeviceClass();
  return DEVICE_DEFAULTS[cls].bargeThreshold;
}
