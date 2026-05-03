/**
 * @fileoverview Client-side barge detection for realtime (WebRTC) calls.
 *
 * Mirrors the turn-based mode's barge loop (turn-based/turnbased.ts) so
 * both modes use the SAME algorithm via the shared BargeWindow class:
 * sliding N-of-K hot frames over a peak threshold, 500 ms warmup mute,
 * `bargeIn` settings kill switch.
 *
 * Why client-side and not bridge-side: the previous architecture ran a
 * Python RMS VAD on RTP-decoded mic frames in audio-bridge/stt_bridge.py.
 * That algorithm was a separate codebase, separate tuning, and had a
 * known state-machine race (stale tts_active cache → false-fire). One
 * algorithm, one tuning, one set of bugs.
 *
 * Wire format: on fire, send `{type:'barge'}` UPSTREAM via the same
 * data channel that previously carried bridge→client barge events. The
 * bridge's dispatch_listener handles the upstream envelope by calling
 * tts_track.halt() (drops queued PCM, flips is_active() False), then
 * the mic→STT loop in stt_bridge resumes on the next frame as if the
 * old bridge-side VAD had fired. See dispatch_listener.py.
 *
 * Caveat — analyser frames on iOS WebRTC capture: iOS Safari can bind
 * WebRTC mic streams exclusively to the peer connection;
 * createMediaStreamSource succeeds but the analyser may read zero
 * frames during the call. Threshold-tuning won't help if frames are
 * structurally zero. If that materializes in production we'll need to
 * either (a) tee the mic via the AudioWorklet path BEFORE addTrack, or
 * (b) revive the bridge-side VAD as an iOS fallback. For now, treat
 * the analyser path as our default and revisit if iOS field-tests
 * report no barge fire.
 */

import { log } from '../../util/log.ts';
import { BargeWindow } from '../shared/barge.ts';
import { playFeedback } from '../shared/feedback.ts';
import * as audioPlatform from '../shared/platform.ts';
import * as settings from '../../settings.ts';

// Same warmup + frame cadence as turn-based — keeps the algorithm
// identical across modes. 500 ms covers the worst speakerphone bleed
// window before the AEC adapter locks on (though we run with
// echoCancellation: false in WebRTC mic acquire, AEC in the speaker
// path can still produce a brief warmup transient).
const BARGE_WARMUP_MS = 500;
const BARGE_FRAME_MS = 50;

let analyser: AnalyserNode | null = null;
let bargeWindow: BargeWindow | null = null;
let bargeMuteUntil = 0;
let bargeLoop: ReturnType<typeof setInterval> | null = null;
let onFireCb: (() => void) | null = null;
let isPlayingCb: (() => boolean) | null = null;
// Diag log throttle — emit one peak/threshold sample per ~500ms
// during TTS playback (every 10th tick at the 50ms cadence) so we can
// see whether the analyser is reading anything at all without log spam.
// Set 2026-05-03 after barge-failed-to-fire field repro on Mac;
// hypothesis: createMediaStreamSource on a WebRTC-bound MediaStream
// returns silence (the iOS caveat may apply to Mac too).
let bargeDiagTickCount = 0;
// Per-call threshold getter — can be overridden by callers that want
// the device-defaults table instead of the raw setting (Phase 4 of
// the unification refactor wires this). Defaults to the setting.
let getThreshold: () => number = () => Number(settings.get().bargeThreshold) || 0.20;

/** Start the barge-detection loop for an active realtime call.
 *
 *  @param micStream  The mic MediaStream the WebRTC peer is sending.
 *  @param isPlaying  Returns true when TTS is currently playing — the
 *                    detector only runs while this is true. Wired to
 *                    suppress.isSuppressing() in main.ts.
 *  @param onFire     Called when a barge is detected. Caller is
 *                    responsible for sending the upstream envelope and
 *                    cancelling local playback. The window is cleared
 *                    here; the loop keeps running so a second fire is
 *                    possible if the caller chooses not to stop().
 *  @param thresholdGetter  Optional override for the threshold-per-frame
 *                    function. Defaults to settings.bargeThreshold.
 */
export function start(
  micStream: MediaStream,
  isPlaying: () => boolean,
  onFire: () => void,
  thresholdGetter?: () => number,
): void {
  stop();
  analyser = audioPlatform.getMicAnalyser(micStream, 256);
  if (!analyser) {
    log('[realtime-barge] no analyser — barge detection disabled');
    return;
  }
  isPlayingCb = isPlaying;
  onFireCb = onFire;
  if (thresholdGetter) getThreshold = thresholdGetter;
  bargeWindow = new BargeWindow();
  // Warmup is rolled forward each time TTS actually starts (see tick),
  // not just at start() — a long silent gap before the first reply
  // shouldn't burn the warmup window.
  bargeMuteUntil = 0;
  bargeLoop = setInterval(tick, BARGE_FRAME_MS);
  log('[realtime-barge] started');
}

/** Stop the barge-detection loop and release the analyser. Idempotent. */
export function stop(): void {
  if (bargeLoop) {
    clearInterval(bargeLoop);
    bargeLoop = null;
  }
  bargeWindow = null;
  analyser = null;
  isPlayingCb = null;
  onFireCb = null;
  bargeMuteUntil = 0;
  // Reset to default getter so a subsequent start() without an override
  // doesn't inherit the previous call's getter.
  getThreshold = () => Number(settings.get().bargeThreshold) || 0.20;
}

/** One frame of barge detection. Skips when not playing TTS, when
 *  warming up, when bargeIn is disabled in settings. Reads peak from
 *  the analyser, feeds the BargeWindow, fires onFireCb on a positive. */
function tick(): void {
  if (!analyser || !bargeWindow) return;
  if (!isPlayingCb || !isPlayingCb()) {
    // TTS not currently playing — clear the window so prior-state samples
    // don't carry into the next playback, and reset the warmup-mute
    // sentinel so the next playback gets a fresh warmup window.
    bargeWindow.clear();
    bargeMuteUntil = 0;
    return;
  }
  // First frame after isPlayingCb flipped to true — arm the warmup mute.
  if (bargeMuteUntil === 0) {
    bargeMuteUntil = Date.now() + BARGE_WARMUP_MS;
  }
  if (Date.now() < bargeMuteUntil) return;

  const s = settings.get();
  // PWA-side bargeIn setting — same kill switch turn-based honors.
  if (!(s as any).bargeIn) return;

  const peak = readPeak(analyser);
  const threshold = getThreshold();
  // Diag: every ~500ms during TTS playback, log what the analyser is
  // actually reading. peak=0.000 sustained means the AnalyserNode isn't
  // getting mic frames (plumbing problem — likely the WebRTC peer has
  // exclusive bind on the MediaStream). peak>threshold sustained without
  // a fire means the BargeWindow N-of-K threshold isn't matching.
  bargeDiagTickCount++;
  if (bargeDiagTickCount % 10 === 0) {
    log(`[realtime-barge] tick peak=${peak.toFixed(3)} threshold=${threshold.toFixed(3)} ttsPlaying=true`);
  }
  if (bargeWindow.push(peak, threshold)) {
    log(`[realtime-barge] fire peak=${peak.toFixed(3)} threshold=${threshold.toFixed(3)}`);
    bargeWindow.clear();
    // Re-arm warmup so a sustained voice doesn't immediately re-fire
    // after the caller halts TTS — the next isPlaying() flip resets
    // bargeMuteUntil cleanly.
    bargeMuteUntil = 0;
    // Audible feedback BEFORE the upstream halt round-trip. The user
    // hears "barge worked" instantly; the actual TTS halt follows
    // when the bridge processes the upstream envelope.
    try { playFeedback('barge'); } catch { /* noop */ }
    try { onFireCb?.(); } catch (e: any) {
      log('[realtime-barge] onFire threw', e?.message);
    }
  }
}

function readPeak(node: AnalyserNode): number {
  const data = new Uint8Array(node.frequencyBinCount);
  node.getByteTimeDomainData(data);
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs((data[i] - 128) / 128);
    if (v > peak) peak = v;
  }
  return peak;
}
