/**
 * @fileoverview OPTIMISTIC-CAPTURE PHASE-0 SPIKE — temporary, remove
 * after the device question is answered (task #194).
 *
 * Question this answers: can a parallel MediaRecorder run on the SAME
 * mic track while an RTCPeerConnection call is live in iOS WKWebView
 * (CAP app) without glitching call audio, dropping the track, or
 * producing silent/empty recordings?
 *
 * Activation: dev mode ON (long-press the version label), or ?oc_spike=1.
 * Kill: ?oc_spike=0. When active, every realtime call records the mic
 * track in parallel and, at call end, POSTs the captured blob to
 * /transcribe purely as a verification probe — the transcript is only
 * LOGGED (grep `[oc-spike]` in the relay log), never sent to a chat.
 *
 * What to look for in the log:
 *   - steady ~1s chunk cadence (big inter-chunk gaps = recorder starved)
 *   - track mute/unmute/ended events (= iOS audio-session route change
 *     stealing the track from under the recorder)
 *   - non-trivial total bytes (~3KB/s at 24kbps; ~0 = silence captured)
 *   - a sane transcript of what was said during the call (proof the
 *     parallel recording contains real speech, not just bytes)
 */

import { log, diag } from '../../util/log.ts';
import { isDevMode } from '../../util/devMode.ts';
import { apiUrl } from '../../apiBase.ts';

let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let chunkCount = 0;
let lastChunkAt = 0;
let maxGapMs = 0;
let startedAt = 0;
let trackListeners: Array<{ track: MediaStreamTrack; type: string; fn: () => void }> = [];

function enabled(): boolean {
  try {
    const qs = new URLSearchParams(location.search);
    if (qs.get('oc_spike') === '0') return false;
    if (qs.get('oc_spike') === '1') return true;
    return isDevMode();
  } catch { return false; }
}

/** Start the parallel recorder on the live call's mic stream. No-op
 *  unless the spike is enabled or a recorder is already running. */
export function maybeStart(micStream: MediaStream): void {
  if (!enabled() || recorder) return;
  const track = micStream.getAudioTracks()[0];
  if (!track) { log('[oc-spike] no audio track on mic stream — abort'); return; }

  chunks = [];
  chunkCount = 0;
  maxGapMs = 0;
  startedAt = performance.now();
  lastChunkAt = startedAt;

  try {
    try {
      recorder = new MediaRecorder(micStream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 24000 });
    } catch {
      recorder = new MediaRecorder(micStream, { audioBitsPerSecond: 24000 });
    }
  } catch (e: any) {
    log('[oc-spike] MediaRecorder construction FAILED', `name=${e?.name}`, `message=${e?.message}`);
    recorder = null;
    return;
  }

  const s = track.getSettings ? track.getSettings() : {};
  log('[oc-spike] START parallel recorder',
    `mime=${recorder.mimeType || '(default)'}`,
    `trackState=${track.readyState}`,
    `aec=${(s as any).echoCancellation}`,
    `rate=${(s as any).sampleRate}`);

  // Track events are the route-change tripwire: iOS steals/mutes the
  // track when the audio session reconfigures, which would silently
  // hollow out the recording.
  for (const type of ['mute', 'unmute', 'ended'] as const) {
    const fn = () => log(`[oc-spike] TRACK ${type} at +${Math.round(performance.now() - startedAt)}ms`);
    track.addEventListener(type, fn);
    trackListeners.push({ track, type, fn });
  }

  recorder.ondataavailable = (e) => {
    const now = performance.now();
    const gap = Math.round(now - lastChunkAt);
    lastChunkAt = now;
    if (gap > maxGapMs) maxGapMs = gap;
    if (e.data && e.data.size > 0) chunks.push(e.data);
    chunkCount++;
    // First few chunks individually, then every 10th — enough to see
    // cadence without flooding the relay on long calls.
    if (chunkCount <= 5 || chunkCount % 10 === 0) {
      log(`[oc-spike] chunk #${chunkCount} ${e.data?.size ?? 0}B gap=${gap}ms`);
    }
  };
  recorder.onerror = (e: any) => {
    log('[oc-spike] recorder ERROR', `name=${e?.error?.name}`, `message=${e?.error?.message}`);
  };
  recorder.start(1000);
}

/** Stop the recorder, log the capture summary, and fire the
 *  /transcribe verification probe. Call BEFORE the mic stream is
 *  released so the final chunk flushes. */
export function stop(reason: string): void {
  if (!recorder) return;
  const rec = recorder;
  recorder = null;
  for (const { track, type, fn } of trackListeners) {
    try { track.removeEventListener(type, fn); } catch {}
  }
  trackListeners = [];

  const durationMs = Math.round(performance.now() - startedAt);
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    chunks = [];
    log('[oc-spike] STOP', `reason=${reason}`,
      `duration=${Math.round(durationMs / 1000)}s`,
      `chunks=${chunkCount}`,
      `bytes=${blob.size}`,
      `maxGap=${maxGapMs}ms`,
      `bytesPerSec=${durationMs > 0 ? Math.round(blob.size / (durationMs / 1000)) : 0}`);
    if (blob.size === 0) {
      log('[oc-spike] VERDICT: empty capture — recorder produced no audio alongside the call');
      return;
    }
    void verifyTranscribe(blob);
  };
  try { rec.stop(); } catch (e: any) {
    diag('[oc-spike] rec.stop threw', e?.message);
  }
}

async function verifyTranscribe(blob: Blob): Promise<void> {
  try {
    const res = await fetch(apiUrl('/transcribe'), {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      log('[oc-spike] verify /transcribe FAILED', `status=${res.status}`);
      return;
    }
    const data = await res.json().catch(() => null);
    if (data && data.ok === false) {
      log('[oc-spike] verify /transcribe rejected:', String(data.error || 'unknown'));
      return;
    }
    const text = (data?.transcript ?? '').trim();
    log('[oc-spike] verify transcript:',
      text ? `"${text.slice(0, 160)}${text.length > 160 ? '…' : ''}"` : '(EMPTY — bytes captured but no speech recognized)');
  } catch (e: any) {
    log('[oc-spike] verify /transcribe error', `name=${e?.name}`, `message=${e?.message}`);
  }
}
