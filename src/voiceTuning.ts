/**
 * @fileoverview Device-class RMS-amplitude thresholds for the
 * turnbased mode's silence-end detector (commits the recording when
 * the mic peak drops below this for the configured silenceSec).
 *
 * NOTE — was previously the slider's source of truth for barge
 * sensitivity (back when BargeDetector had an RMS gate). The barge
 * VAD slider is now Silero-domain via settings.bargeVadThreshold —
 * this module's only remaining consumer is `turnbased.ts`'s silence-
 * end RMS gate, which will retire when turnbased mode goes away.
 *
 * Per-device because mic + capture paths produce substantially
 * different baseline peaks:
 *   - iOS Safari WebRTC: built-in voice isolation pulls peaks to
 *     ~0.014-0.020 for normal speech (3x lower than Mac no-AEC)
 *   - macOS / Linux / Windows (clean USB / built-in): speech ~0.05-0.08
 *   - Android: moderate, varies by handset
 */

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
  // Recalibrated v0.389 for AEC-OFF mic (reverted from v0.387's AEC-on
  // experiment — Chrome AEC over-attenuated user voice during TTS to
  // the ambient floor, no fire possible). Back to v0.385 measurements:
  // Mac no-AEC speech peaks 0.05-0.08, ambient floor ~0.008.
  // iOS v0.396: dropped to 0.018 — iOS Safari's WebRTC stack ignores
  // our echoCancellation:false flag and applies built-in voice
  // isolation; iPhone peaks for normal speech sit ~0.014-0.020 (3x
  // smaller than Mac no-AEC peaks of 0.05-0.08).
  ios: { bargeThreshold: 0.018 },
  android: { bargeThreshold: 0.020 },  // assume similar processing
  mac: { bargeThreshold: 0.025 },     // ~half of measured speech, well above floor
  linux: { bargeThreshold: 0.025 },
  windows: { bargeThreshold: 0.025 },
};

/** Read-through accessor for the device-default RMS threshold used by
 *  turnbased's silence-end detector. No caching: device class can't
 *  change at runtime but the function is cheap (UA sniff + dict). */
export function getBargeThreshold(): number {
  return DEVICE_DEFAULTS[detectDeviceClass()].bargeThreshold;
}
