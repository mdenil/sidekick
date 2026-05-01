/**
 * @fileoverview Listen — turn-based handsfree mic mode. Records locally
 * with MediaRecorder (mirroring memo), runs Web Speech API for sendword
 * detection in parallel (Phase 2), and on commit ships the FULL
 * buffered blob to /v1/transcribe (via /transcribe). Reply renders +
 * plays through the existing playReplyTts path (caller-owned). After
 * audio.ended + a small grace window, re-arms for the next turn.
 *
 * Listen is wiring on top of existing primitives, NOT a new pipeline.
 * WebRTC (talk + stream) stays untouched — Listen lives alongside.
 *
 * State machine:
 *   idle       — start() not yet called or stop() returned.
 *   armed      — recording, watching for silence (+ sendword in Phase 2).
 *   committing — silence/sendword fired; awaiting onCommit caller.
 *   playing    — caller invoked notifyReplyPlayback(true); waiting
 *                for notifyReplyPlayback(false) → grace → re-arm.
 *
 * Disarm: mic-button tap or menu-toggle off, both wired through stop().
 *
 * Test hooks: when ?listen_mock_mic=1 is set on the URL, the module
 * exposes window.__listen.{state, injectSilence, injectSpeech} so the
 * Playwright smoke can drive synthetic frames into the silence detector
 * without a real getUserMedia stream.
 */

import { log, diag } from '../util/log.ts';
import * as audioPlatform from './platform.ts';
import * as settings from '../settings.ts';
import { playFeedback } from './feedback.ts';
import * as sendwordDetector from './sendwordDetector.ts';

export type ListenState = 'idle' | 'armed' | 'committing' | 'playing' | 'cooldown';

export type ListenOpts = {
  /** Called when a turn commits (silence elapsed or sendword detected).
   *  Receives the recorded audio blob; caller is responsible for posting
   *  it to /transcribe and rendering the reply. The caller MUST drive
   *  notifyReplyPlayback(true/false) around TTS playback so Listen knows
   *  when to re-arm. Returning a rejected promise leaves Listen in the
   *  cooldown → armed transition (best-effort recovery). */
  /** `reason` lets the caller know whether this turn ended via the
   *  silence timeout or because the sendword fired. Only the latter
   *  needs the trailing sendword stripped from the transcript before
   *  rendering. Defaults to 'silence' for callers that don't care.
   *  'barge' = user spoke during TTS playback to interrupt; the
   *  caller should cancel any in-flight TTS before invoking
   *  notifyReplyPlayback(false) so Listen re-arms cleanly. */
  onCommit: (blob: Blob, reason?: 'silence' | 'sendword' | 'barge') => Promise<void> | void;
  /** Optional: fired when barge detection triggers during TTS playback.
   *  Caller should cancel its TTS playback (text-tts.cancelReplyTts) and
   *  immediately call notifyReplyPlayback(false) so Listen drops the
   *  current "playing" state and re-arms. The very next user utterance
   *  starts a fresh recording with no committed blob (the barge IS the
   *  signal — we don't ship the bleed-into-mic audio as a turn). */
  onBarge?: () => void;
  /** Called when the trash button is tapped or stop() is invoked while
   *  armed without a commit. UI should clear the listening indicator. */
  onCancel?: () => void;
  /** Optional hook fired on each state transition. Useful for the
   *  status-line indicator + button class wiring in main.ts. */
  onState?: (s: ListenState) => void;
};

const REARM_GRACE_MS = 500;
const SILENCE_WARMUP_MS = 500;
const SILENCE_FRAME_MS = 50;
// Barge detection (active during 'playing' state) — sliding window of
// the last BARGE_WINDOW_FRAMES peak readings, fires when ≥ BARGE_REQUIRED
// of them are above settings.bargeThreshold. Ignores the first BARGE_WARMUP_MS
// of TTS playback (worst speakerphone bleed window). Same algorithm as
// the classic pipeline's bargeIn.ts (08f50ac:src/pipelines/classic/bargeIn.ts:35-100):
// rejects single-burst noise (wind gust, tap on phone) but catches
// sustained speech with mid-syllable amplitude dips.
const BARGE_WARMUP_MS = 500;
const BARGE_FRAME_MS = 50;
const BARGE_WINDOW_FRAMES = 5;
const BARGE_REQUIRED_HOT = 4;

let state: ListenState = 'idle';
let opts: ListenOpts | null = null;
let mediaStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let analyser: AnalyserNode | null = null;
let silenceLoop: ReturnType<typeof setInterval> | null = null;
let bargeLoop: ReturnType<typeof setInterval> | null = null;
let bargeWindow: number[] = [];
let bargeMuteUntil = 0;
let armedAt = 0;
let lastVoiceAt = 0;
let mockFrames: { type: 'silence' | 'speech'; remainingMs: number } | null = null;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;

/** External read of the current state. */
export function getState(): ListenState { return state; }

/** Notify Listen that reply playback started/ended. The PWA's reply
 *  pipeline owns the audio element; Listen just observes. While
 *  playing, the mic stays open but silence/sendword detection is
 *  paused (no barge logic — settled decision). */
export function notifyReplyPlayback(playing: boolean): void {
  if (playing) {
    if (state === 'committing' || state === 'armed' || state === 'playing') {
      transition('playing');
      // Pause the sendword detector during TTS — the user's mic would
      // otherwise pick up the agent's voice and trip a false match.
      try { sendwordDetector.stop(); } catch { /* noop */ }
      // Start barge detection. The mic stream stays open through TTS
      // (per design); we now actively listen for sustained user voice
      // above the threshold during playback. Fire → caller cancels TTS
      // and re-arms (via the onBarge callback). Browser AEC + the
      // 500ms warmup mute handle most speakerphone bleed; classic ran
      // this same algorithm reliably on a Pi for months.
      startBargeLoop();
    }
    return;
  }
  // Stopping playback path — clear the barge loop regardless of how
  // we got here (natural reply end, barge fire, user cancel).
  stopBargeLoop();
  if (state === 'playing') {
    // Grace window before re-arming so the audio tail and any trailing
    // events (audio.onended → next event-loop tick) settle.
    transition('cooldown');
    if (cooldownTimer) clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      if (getState() !== 'cooldown') return;
      // Re-arm by rebuilding the recorder. The mic stream is still
      // alive; we just need a fresh blob accumulator. armRecorder()
      // also restarts the sendword detector.
      armRecorder().catch((e) => {
        diag('listen: re-arm failed', e?.message);
        // Fall back to idle; caller can re-tap to retry.
        teardown();
      });
    }, REARM_GRACE_MS);
  }
}

/** Start arming Listen. Acquires the mic, builds analyser + recorder,
 *  starts the silence loop. Idempotent: if already non-idle, returns
 *  the current state. */
export async function start(o: ListenOpts): Promise<boolean> {
  if (state !== 'idle') return true;
  opts = o;
  // Reuse the shared AudioContext primed by the caller's gesture.
  const ctx = audioPlatform.getSharedAudioCtx();
  if (!ctx) {
    log('listen: no shared AudioContext — was primeAudio() skipped?');
    return false;
  }
  if (ctx.state !== 'running') {
    try { await ctx.resume(); } catch { /* ignore */ }
  }
  try {
    mediaStream = await audioPlatform.getMicStream('listen');
  } catch (e: any) {
    log('listen: mic error:', e?.message);
    teardown();
    return false;
  }
  analyser = audioPlatform.getMicAnalyser(mediaStream, 256);
  if (!analyser) {
    log('listen: analyser unavailable — silence detection disabled');
  }
  ensureVisibilityHandler();
  await armRecorder();
  // "Listening" chime — same audible cue memo uses, so the user gets a
  // consistent "we're hearing you" signal across the two modes.
  try { playFeedback('listening'); } catch { /* noop */ }
  installTestHooksIfRequested();
  return true;
}

/** Visibility-change handler — pause sendword detection when the tab
 *  goes to the background. Web Speech API is unreliable while hidden
 *  on iOS Safari (sessions get killed silently, restart loop fails);
 *  on resume we re-arm the detector if Listen is still active. The
 *  silence loop keeps running so a memo recorded while pocketed still
 *  commits — only sendword pauses. */
let visibilityHandlerInstalled = false;
function ensureVisibilityHandler(): void {
  if (visibilityHandlerInstalled) return;
  if (typeof document === 'undefined') return;
  visibilityHandlerInstalled = true;
  document.addEventListener('visibilitychange', () => {
    if (state !== 'armed' && state !== 'committing') return;
    if (document.visibilityState === 'hidden') {
      try { sendwordDetector.stop(); } catch { /* noop */ }
    } else {
      // Re-arm sendword on resume if we're still in armed state.
      if (state === 'armed') {
        const s = settings.get();
        const engine = (s as any).listenSttEngine || 'local';
        const phrase = (((s as any).listenSendword as string) || s.commitPhrase || '').trim();
        if (phrase && engine !== 'silence-only') {
          sendwordDetector.start({
            phrase,
            onMatch: () => commitFromSendword(),
          });
        }
      }
    }
  });
}

async function armRecorder(): Promise<void> {
  if (!mediaStream) {
    teardown();
    return;
  }
  audioChunks = [];
  try {
    mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus' });
  } catch {
    mediaRecorder = new MediaRecorder(mediaStream);
  }
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
  mediaRecorder.start(1000);
  armedAt = Date.now();
  lastVoiceAt = armedAt;
  startSilenceLoop();
  // Sendword detector: empty listenSendword falls back to commitPhrase
  // (per-spec). Fail-soft — if SR is unsupported, listen continues with
  // silence-only commits. listenSttEngine='silence-only' forces the
  // user-side opt-out path even when SR IS available.
  const s = settings.get();
  const engine = (s as any).listenSttEngine || 'local';
  const phrase = (((s as any).listenSendword as string) || s.commitPhrase || '').trim();
  if (phrase && engine !== 'silence-only') {
    sendwordDetector.start({
      phrase,
      onMatch: () => commitFromSendword(),
    });
  }
  transition('armed');
}

function startSilenceLoop(): void {
  if (silenceLoop) clearInterval(silenceLoop);
  silenceLoop = setInterval(tickSilence, SILENCE_FRAME_MS);
}

function stopSilenceLoop(): void {
  if (silenceLoop) { clearInterval(silenceLoop); silenceLoop = null; }
}

function startBargeLoop(): void {
  if (bargeLoop) clearInterval(bargeLoop);
  bargeWindow = [];
  bargeMuteUntil = Date.now() + BARGE_WARMUP_MS;
  bargeLoop = setInterval(tickBarge, BARGE_FRAME_MS);
}

function stopBargeLoop(): void {
  if (bargeLoop) { clearInterval(bargeLoop); bargeLoop = null; }
  bargeWindow = [];
  bargeMuteUntil = 0;
}

/** One frame of barge detection. Mirrors the classic bargeIn evaluator
 *  (08f50ac:src/pipelines/classic/bargeIn.ts:62-100): sliding window of
 *  the last BARGE_WINDOW_FRAMES peak readings, fire when ≥ BARGE_REQUIRED
 *  are above settings.bargeThreshold. The 500ms warmup mute skips the
 *  worst speakerphone bleed window before the AEC adapter locks on. */
function tickBarge(): void {
  if (state !== 'playing') return;
  if (!analyser) return;
  if (Date.now() < bargeMuteUntil) return;

  const s = settings.get();
  // PWA-side bargeIn setting acts as a kill switch for Listen too —
  // user toggling barge off in the menu disables here, same wire as
  // the WebRTC path (which sends barge_enabled in the offer).
  if (!(s as any).bargeIn) return;

  const peak = readPeak(analyser);
  const threshold = ((s.bargeThreshold as number) || 0.20);
  const hot = peak > threshold ? 1 : 0;
  bargeWindow.push(hot);
  if (bargeWindow.length > BARGE_WINDOW_FRAMES) bargeWindow.shift();

  if (bargeWindow.length < BARGE_WINDOW_FRAMES) return;
  let sum = 0;
  for (const v of bargeWindow) sum += v;
  if (sum >= BARGE_REQUIRED_HOT) {
    log(`listen: barge fire peak=${peak.toFixed(3)} hot=${sum}/${BARGE_WINDOW_FRAMES}`);
    stopBargeLoop();
    try { opts?.onBarge?.(); } catch (e: any) {
      diag('listen: onBarge threw', e?.message);
    }
  }
}

/** One frame of silence detection. Reads peak from the analyser (or the
 *  injected mock-frame queue when a smoke test is driving us). When the
 *  gap since the last speech frame exceeds settings.listenSilenceSec,
 *  fires commit. */
function tickSilence(): void {
  if (state !== 'armed') return;
  const now = Date.now();
  if (now - armedAt < SILENCE_WARMUP_MS) {
    // Skip the warmup window so the "listening" chime + late mic
    // unmute don't get counted as silence.
    return;
  }

  const s = settings.get();
  // settings.listenSilenceSec lives in DEFAULTS as of Phase 1; default 8s.
  const silenceMs = (((s as any).listenSilenceSec as number) || 8) * 1000;

  let isSpeech = false;
  if (mockFrames && mockFrames.remainingMs > 0) {
    isSpeech = mockFrames.type === 'speech';
    mockFrames.remainingMs -= SILENCE_FRAME_MS;
    if (mockFrames.remainingMs <= 0) mockFrames = null;
  } else if (analyser) {
    isSpeech = readPeak(analyser) > ((s.bargeThreshold as number) || 0.20);
  }

  if (isSpeech) {
    lastVoiceAt = now;
    return;
  }
  if (now - lastVoiceAt >= silenceMs) {
    void commitNow('silence');
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

/** Internal: stop the recorder, harvest the blob, fire onCommit. */
async function commitNow(reason: 'silence' | 'sendword'): Promise<void> {
  if (state !== 'armed') return;
  transition('committing');
  stopSilenceLoop();
  try { sendwordDetector.stop(); } catch { /* noop */ }
  const blob = await stopRecorder();
  log(`listen: commit (${reason}) blob=${blob ? blob.size : 0}b`);
  if (!blob || blob.size === 0) {
    // Empty blob — re-arm directly without invoking onCommit.
    armRecorder().catch(() => teardown());
    return;
  }
  try {
    const out = opts?.onCommit?.(blob, reason);
    if (out && typeof (out as Promise<void>).then === 'function') {
      await out;
    }
  } catch (e: any) {
    diag('listen: onCommit threw', e?.message);
    // Best-effort recovery — re-arm so the user isn't stranded.
    armRecorder().catch(() => teardown());
    return;
  }
  // If the caller never moved us to 'playing' (e.g. the reply was
  // empty so playReplyTts skipped), re-arm directly after a grace.
  // Read via getState() so TS doesn't narrow on the literal we set above.
  if (getState() === 'committing') {
    transition('cooldown');
    if (cooldownTimer) clearTimeout(cooldownTimer);
    cooldownTimer = setTimeout(() => {
      cooldownTimer = null;
      if (getState() === 'cooldown') {
        armRecorder().catch(() => teardown());
      }
    }, REARM_GRACE_MS);
  }
}

async function stopRecorder(): Promise<Blob | null> {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') return null;
  const mimeType = mediaRecorder.mimeType;
  await new Promise<void>((resolve) => {
    mediaRecorder!.onstop = () => resolve();
    try { mediaRecorder!.stop(); } catch { resolve(); }
    setTimeout(resolve, 1000);
  });
  if (audioChunks.length === 0) return null;
  return new Blob(audioChunks, { type: mimeType });
}

/** Force a commit now (sendword detector path). Safe to call only from
 *  state==='armed'; otherwise no-op. */
export function commitFromSendword(): void {
  if (state !== 'armed') return;
  void commitNow('sendword');
}

/** Cancel without committing (trash button, mic-button-off). Releases
 *  the mic and resets state to idle. */
export function cancel(): void {
  const wasArmed = state !== 'idle';
  teardown();
  if (wasArmed && opts?.onCancel) {
    try { opts.onCancel(); } catch { /* noop */ }
  }
}

/** Stop and release everything. Equivalent to cancel() but doesn't
 *  invoke the onCancel callback — used by the menu-toggle off path. */
export function stop(): void {
  teardown();
}

function teardown(): void {
  stopSilenceLoop();
  if (cooldownTimer) { clearTimeout(cooldownTimer); cooldownTimer = null; }
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  } catch { /* noop */ }
  mediaRecorder = null;
  audioChunks = [];
  if (mediaStream) {
    audioPlatform.releaseMicStream('listen');
    mediaStream = null;
  }
  analyser = null;
  mockFrames = null;
  try { sendwordDetector.stop(); } catch { /* noop */ }
  transition('idle');
}

function transition(s: ListenState): void {
  if (state === s) return;
  state = s;
  try { opts?.onState?.(s); } catch { /* noop */ }
  // Refresh the test hook surface every transition so polling sees fresh state.
  installTestHooksIfRequested();
}

// ── Test hooks ─────────────────────────────────────────────────────────
// Activated only when ?listen_mock_mic=1 is on the URL. Smokes drive
// synthetic frames in via injectSilence/injectSpeech instead of routing
// real mic audio.

function isMockMicEnabled(): boolean {
  try {
    const qs = new URLSearchParams(location.search);
    return qs.get('listen_mock_mic') === '1';
  } catch {
    return false;
  }
}

function installTestHooksIfRequested(): void {
  if (typeof window === 'undefined') return;
  if (!isMockMicEnabled()) return;
  (window as any).__listen = {
    get state() { return state; },
    injectSilence(durationMs: number) {
      mockFrames = { type: 'silence', remainingMs: durationMs };
      // Also pretend we never heard speech — set lastVoiceAt back so
      // the configured silence window can elapse.
      lastVoiceAt = Date.now() - durationMs;
    },
    injectSpeech(durationMs: number) {
      mockFrames = { type: 'speech', remainingMs: durationMs };
      lastVoiceAt = Date.now();
    },
    commit() { void commitNow('sendword'); },
  };
}
