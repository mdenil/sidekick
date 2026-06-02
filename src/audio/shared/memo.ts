/**
 * @fileoverview Voice memo — WhatsApp-style local recording with waveform
 * and timer. Transcription happens on send (batch via /transcribe), not
 * during recording. This means:
 *  - Truly offline-capable: no network needed to record.
 *  - Same code path for online and offline sends (always POST the blob).
 *  - No race conditions on stop (no WS state to wait for).
 *
 * The visual row (trash button, dot, timer, waveform, optional send
 * button) lives in `recorderBar.ts` so Listen mode can reuse it.
 */

import { log } from '../../util/log.ts';
import * as audioPlatform from './platform.ts';
import { playFeedback } from './feedback.ts';
import * as recorderBar from './recorderBar.ts';

let mediaStream = null;
// AudioContext is the SHARED one from the platform shim. Streaming + TTS
// use the same context; iOS permits ~4 live contexts and we were
// creating/closing a fresh one per memo. Using the shared ctx avoids
// that pressure and simplifies state (auto-resume on visibilitychange
// is already handled by audio-unlock.ts under the platform shim). We
// hold a module-local ref for convenience but never close it.
let audioCtx = null;
let mediaRecorder = null;
let audioChunks = [];
let bar: recorderBar.RecorderBar | null = null;
let startTime = 0;
let stopping = false;

export function isSupported() { return typeof MediaRecorder !== 'undefined'; }

/**
 * Start recording.
 * @param {Object} opts
 * @param {HTMLElement} opts.container
 * @param {HTMLElement} [opts.insertBefore]
 * @param {HTMLElement} [opts.sendBtn] — if provided, this existing button DOM
 *   node is moved into the recording bar (WhatsApp-style trash/timer/wave/send
 *   on a single row). Caller restores it on exit.
 * @param {(audioBlob: Blob|null) => void} opts.onDone
 * @param {() => void} opts.onCancel
 */
export async function start(opts) {
  // Use the shared AudioContext via the platform shim — created in a
  // prior user gesture (primeAudio(player) is called by main.ts's memo
  // onclick right before this) so it's already 'running' by the time
  // we get here. No need to create our own context; no need to kick off
  // a new resume (the platform handles resume + visibilitychange
  // auto-resume).
  audioCtx = audioPlatform.getSharedAudioCtx();
  if (!audioCtx) {
    log('memo: no shared AudioContext — was primeAudio() skipped?');
    if (opts.onCancel) opts.onCancel();
    return false;
  }
  // Defensive: if the ctx slipped out of 'running' (iOS interrupt), try to
  // resume. Safe even without a gesture once the ctx is initially unlocked.
  const resumePromise = audioCtx.state !== 'running' ? audioCtx.resume() : null;

  // Render UI IMMEDIATELY — don't wait for the mic permission chime or
  // audio pipeline setup. The recorder bar's rAF loop safely no-ops when
  // no analyser is attached, so starting it early means bars animate the
  // moment the analyser connects.
  startTime = Date.now();
  bar = recorderBar.mount({
    container: opts.container,
    insertBefore: opts.insertBefore,
    sendBtn: opts.sendBtn,
    onCancel: () => { cleanup(); if (opts.onCancel) opts.onCancel(); },
  });

  try {
    // Centralized capture via platform shim — handles iOS AVAudioSession
    // prep + getUserMedia + single-owner mutual exclusion. Throws if
    // another subscriber (streaming) still holds the stream — callers
    // (main.ts's memo button) guarantee that state is released before
    // calling start().
    mediaStream = await audioPlatform.getMicStream('memo', {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    });
  } catch (e) {
    log('memo: mic error:', e.message);
    cleanup();
    if (opts.onCancel) opts.onCancel();
    return false;
  }

  if (resumePromise) { try { await resumePromise; } catch {} }
  log('memo: audioCtx state=', audioCtx.state);
  // Build the analyser via the platform shim — same path fakeLock uses,
  // single source of truth for "wire an analyser to a mic stream."
  // MediaRecorder consumes the MediaStream directly below; the analyser
  // is purely for the visual waveform.
  const analyser = audioPlatform.getMicAnalyser(mediaStream, 256);
  if (!analyser) {
    log('memo: getMicAnalyser returned null — visual waveform disabled');
  }
  bar?.attachAnalyser(analyser);

  // MediaRecorder captures audio as a blob — the only thing that matters for send
  audioChunks = [];
  // Cap the audio bitrate at 24 kbps. Speech-to-text (Deepgram / Whisper)
  // transcribes low-bitrate audio fine, and the default MediaRecorder
  // bitrate (~216 kbps default) makes
  // multi-minute memos ~10x larger than they need to be — a 92s memo
  // shrank from 2.5MB to ~250KB, cutting park-bench 5G upload time
  // from 22s to ~2s. Works on iOS Safari (AAC) and Chrome (Opus).
  try {
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 24000 });
  } catch {
    mediaRecorder = new MediaRecorder(mediaStream, { audioBitsPerSecond: 24000 });
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.start(1000);

  log('memo: recording (MediaRecorder → blob)');
  // "Listening" chime — soft two-tone fade-in confirming the mic path
  // is actually live. Replaces the older 'start' tick; same role
  // (audible "we're hearing you" signal) but slightly more distinct so
  // it isn't confused with the 'commit' or 'send' chimes.
  playFeedback('listening');
  // Visual pulse — adds .listening to the mic button alongside .active
  // so user sees "actually capturing" vs "got my touch" states. Cleared
  // with .active on stopVoice.
  try { document.getElementById('btn-mic')?.classList.add('listening'); } catch {}
  return true;
}

/** Cancel the current memo without producing a blob — equivalent to
 *  tapping the trash button, but exposed as a method so other modules
 *  (e.g. main.ts's releaseCaptureIfActive) can coordinate without
 *  resorting to synthetic DOM clicks. Safe to call from any reset path;
 *  no-op when no memo is active. Does not invoke the onCancel callback
 *  passed to start() — callers that need UI teardown should handle that
 *  separately (e.g. exitMemoMode in main.ts). */
export function cancel() {
  cleanup();
}

/** Stop recording, return audio blob. Transcription happens on the caller's side. */
export async function stop() {
  if (stopping) return { audioBlob: null, durationMs: 0 };
  stopping = true;

  const durationMs = startTime ? Date.now() - startTime : 0;

  let audioBlob = null;
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    // Capture mimeType before the await — another code path (e.g.
    // releaseCaptureIfActive → trash.click → cleanup) can null
    // `mediaRecorder` while we're waiting for onstop to fire, which
    // made the post-await `mediaRecorder.mimeType` access crash.
    const mimeType = mediaRecorder.mimeType;
    await new Promise<void>(resolve => {
      mediaRecorder.onstop = () => resolve();
      try { mediaRecorder.stop(); } catch { resolve(); }
      setTimeout(resolve, 1000); // safety net
    });
    if (audioChunks.length > 0) {
      audioBlob = new Blob(audioChunks, { type: mimeType });
    }
  }

  cleanup();
  stopping = false;
  return { audioBlob, durationMs };
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

function cleanup() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') { try { mediaRecorder.stop(); } catch {} }
  mediaRecorder = null;
  audioChunks = [];
  // MediaStream ownership lives in the platform shim (delegating to
  // capture.ts) — release through there so mutual-exclusion state stays
  // consistent. Null our local ref too since other functions in this
  // module check it during teardown.
  audioPlatform.releaseMicStream('memo');
  mediaStream = null;
  // AudioContext is shared — DO NOT close it (would kill streaming + TTS).
  // Just drop our reference. The analyser/source nodes we created will be
  // garbage-collected once no references remain.
  audioCtx = null;
  startTime = 0;
  if (bar) { bar.destroy(); bar = null; }
}
