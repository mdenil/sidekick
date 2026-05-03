/**
 * @fileoverview Listen — turn-based handsfree mic mode. Two body-
 * transcription paths, gated by the `streamingEngine` setting:
 *
 *   - SERVER (`streamingEngine: 'server'`, the default) — record locally
 *     with MediaRecorder, run Web Speech API for sendword detection in
 *     parallel, and on commit ship the FULL buffered blob to
 *     /v1/transcribe (via /transcribe). Caller's `onCommit(blob, reason)`
 *     fires.
 *
 *   - LOCAL (`streamingEngine: 'local'`) — no blob, no /transcribe.
 *     Open a `BrowserSttProvider` (Web Speech API) and accumulate its
 *     transcript events into the turn's body text. Sendword detector
 *     subscribes to the SAME provider via the new external-source API
 *     so we run a single SR session per turn instead of two racing for
 *     the mic. On commit, caller's `onCommitText(text, reason)` fires.
 *
 * Reply renders + plays through the existing playReplyTts path
 * (caller-owned). After audio.ended + a small grace window, re-arms for
 * the next turn.
 *
 * Listen is wiring on top of existing primitives, NOT a new pipeline.
 * WebRTC (talk + stream) stays untouched — Listen lives alongside.
 *
 * State machine:
 *   idle       — start() not yet called or stop() returned.
 *   armed      — recording (server) or live-transcribing (local),
 *                watching for silence + sendword.
 *   committing — silence/sendword fired; awaiting onCommit/onCommitText.
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

import { log, diag } from '../../util/log.ts';
import * as audioPlatform from '../shared/platform.ts';
import * as settings from '../../settings.ts';
import { playFeedback } from '../shared/feedback.ts';
import * as sendwordDetector from './sendwordDetector.ts';
import { SilenceWindow, getHandsfreeConfig } from '../shared/handsfree.ts';
import { BargeWindow } from '../shared/barge.ts';
import { getBargeThreshold } from '../../voiceTuning.ts';
import * as recorderBar from '../shared/recorderBar.ts';
import { BrowserSTTProvider, isSupported as isBrowserSttSupported } from '../streaming/browserDictate.ts';
import type { STTProvider, TranscriptEvent } from '../shared/stt-provider.ts';

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
  /** Called when a turn commits in LOCAL streaming-engine mode. The
   *  body transcription has already happened in-browser via Web Speech
   *  — caller just needs to render+submit the supplied `text`. Empty
   *  text means the user said nothing transcribable; caller should
   *  skip the send (Listen will re-arm directly). When set, this
   *  REPLACES `onCommit` — the two paths are mutually exclusive per
   *  turn (the engine setting determines which fires). When omitted,
   *  local mode silently degrades to the server path. */
  onCommitText?: (text: string, reason?: 'silence' | 'sendword' | 'barge') => Promise<void> | void;
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
  /** Container element to mount the visual recorder bar (waveform +
   *  trash button) into. Pass the composer element. When omitted, no
   *  bar mounts (smoke tests, headless contexts). */
  barContainer?: HTMLElement | null;
  /** Optional sibling to insertBefore inside `barContainer` — same
   *  semantics as memo.start (drops the bar in front of the composer
   *  actions row). */
  barInsertBefore?: HTMLElement | null;
  /** Optional element to relocate INTO the bar's right-end slot.
   *  Memo uses this to embed the send button; Listen uses it to embed
   *  the mic button (so the user has a visible "end call" affordance
   *  in the same physical spot). Caller is responsible for restoring
   *  the element to its original parent on teardown — the bar's
   *  destroy() doesn't track where it came from. */
  barRightBtn?: HTMLElement | null;
};

const REARM_GRACE_MS = 500;
const SILENCE_WARMUP_MS = 500;
const SILENCE_FRAME_MS = 50;
// Barge detection (active during 'playing' state). Algorithm lives
// in shared/barge.ts (sliding N-of-K hot frames, used by both modes).
// We just own the warmup mute + frame cadence here — same 500ms
// warmup as the classic pipeline (worst speakerphone bleed window
// before the AEC adapter locks on).
const BARGE_WARMUP_MS = 500;
const BARGE_FRAME_MS = 50;

let state: ListenState = 'idle';
let opts: ListenOpts | null = null;
let mediaStream: MediaStream | null = null;
let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let analyser: AnalyserNode | null = null;
let silenceLoop: ReturnType<typeof setInterval> | null = null;
let bargeLoop: ReturnType<typeof setInterval> | null = null;
let bargeWindow: BargeWindow | null = null;
let bargeMuteUntil = 0;
let armedAt = 0;
let silenceWindow: SilenceWindow | null = null;
let mockFrames: { type: 'silence' | 'speech'; remainingMs: number } | null = null;
let cooldownTimer: ReturnType<typeof setTimeout> | null = null;
// Visual recorder bar (waveform + trash button). Mounted on start(),
// destroyed on teardown. Analyser is attached only while state==='armed'
// — frozen waveform during commit/playing/cooldown so the user never
// sees a live waveform that misrepresents whether audio is being
// captured for transcription.
let bar: recorderBar.RecorderBar | null = null;
// LOCAL engine (streamingEngine='local') turn-state. The active
// BrowserSttProvider for in-browser body transcription, the running
// transcript accumulator (final segments concatenated as they arrive,
// latest interim layered on top for live display), and the unsubscribe
// handle for our transcript listener. Null on every server-engine turn.
let localProvider: STTProvider | null = null;
let localFinalText = '';
let localLastInterim = '';
let localUnsub: (() => void) | null = null;
/** True when the current turn was armed against the local provider —
 *  determines whether commit harvests text vs blob. Captured at arm
 *  time so a mid-turn settings flip doesn't rip the floor out from
 *  under commitNow. */
let armedWithLocal = false;

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
      armRecorder().then(() => {
        // Listening chime on re-arm too, not just on initial start.
        // Without this the user has no audible cue that "your turn
        // again, mic is hot." Critical when running handsfree (eyes
        // off the screen — the original ask was "I'm flying blind").
        try { playFeedback('listening'); } catch { /* noop */ }
      }).catch((e) => {
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
  // Mount the visual recorder bar (waveform + trash). Same module memo
  // uses; analyser gets attached/detached as state moves in/out of
  // 'armed' so the waveform is honest about when audio is being captured
  // for transcription. Skipped when no container — smoke tests, headless.
  if (o.barContainer) {
    bar = recorderBar.mount({
      container: o.barContainer,
      insertBefore: o.barInsertBefore || null,
      // Right-slot button — caller passes the mic button (Listen) so
      // the user has a visible "end call" affordance at the bar's
      // right end. Memo passes its send button; same DOM slot.
      sendBtn: o.barRightBtn || null,
      onCancel: () => {
        // Trash button = disarm. cancel() runs teardown which destroys
        // the bar, so the click handler doesn't need to do that itself.
        cancel();
      },
    });
  }
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
        const engine = (settings.get() as any).listenSttEngine || 'local';
        const { sendwordPhrase } = getHandsfreeConfig();
        if (sendwordPhrase && engine !== 'silence-only') {
          sendwordDetector.start({
            phrase: sendwordPhrase,
            onMatch: () => commitFromSendword(),
            // Pass the same provider source we're armed against so the
            // detector resumes onto the existing SR session rather than
            // racing it with a new instance.
            source: armedWithLocal && localProvider ? localProvider : undefined,
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
  // Engine selection — `streamingEngine: 'local'` opts out of the
  // MediaRecorder → /transcribe path entirely. Body transcription runs
  // in-browser via Web Speech (BrowserSttProvider). Caller's
  // onCommitText receives the accumulated transcript at commit time.
  // We require BOTH the setting AND a working SR ctor AND a caller
  // that supplied onCommitText — any missing piece falls through to
  // the server path so the user still gets a working Listen mode
  // (e.g. Firefox without WebSpeech, or a caller that hasn't been
  // updated to handle local mode).
  const useLocal = (settings.get() as any).streamingEngine === 'local'
    && isBrowserSttSupported()
    && typeof opts?.onCommitText === 'function';
  armedWithLocal = useLocal;

  // Tear down any provider/recorder from a prior turn. We rebuild fresh
  // each arm so a stop()/arm() cycle starts cleanly (Chromium leaks
  // state across MediaRecorder instances → corrupt webm; SR sessions
  // benefit from the same hygiene).
  await teardownLocalProvider();
  if (mediaRecorder) {
    try { mediaRecorder.ondataavailable = null; } catch { /* noop */ }
    try { mediaRecorder.onstop = null; } catch { /* noop */ }
    mediaRecorder = null;
  }
  audioChunks = [];

  if (useLocal) {
    // LOCAL path — Web Speech provider for body transcription.
    // No MediaRecorder, no blob. The mic stream stays open (analyser
    // still drives the silence/barge loops); BrowserSttProvider opens
    // its own SR session against the OS-default mic, which on iOS +
    // Chrome shares the same source as the mediaStream we already
    // hold. The redundant getUserMedia call inside SR is the platform
    // contract we accept.
    localFinalText = '';
    localLastInterim = '';
    localProvider = new BrowserSTTProvider();
    try {
      localUnsub = localProvider.onTranscript((ev: TranscriptEvent) => {
        if (ev.role !== 'user') return;
        if (ev.is_final) {
          // Empty-text finals are the synthetic utterance-end sentinel
          // BrowserSttProvider emits on `onend`. They carry no text;
          // the prior content-final already accumulated.
          if (ev.text) {
            localFinalText = (localFinalText + ' ' + ev.text).trim();
          }
          localLastInterim = '';
        } else {
          localLastInterim = ev.text;
        }
      });
      await localProvider.start();
    } catch (e: any) {
      diag('listen: local provider start failed, falling back to server', e?.message);
      await teardownLocalProvider();
      armedWithLocal = false;
    }
  }

  if (!armedWithLocal) {
    // SERVER path — MediaRecorder buffers a blob for /transcribe.
    // Cap the audio bitrate at 24 kbps. Speech-to-text (Deepgram /
    // Whisper) transcribes low-bitrate audio fine, and the default
    // MediaRecorder bitrate (~216 kbps measured in field testing
    // 2026-05-03) makes multi-minute memos ~10x larger than they need
    // to be — a 92s memo shrank from 2.5MB to ~250KB, cutting park-
    // bench 5G upload time from 22s to ~2s. Works on iOS Safari (AAC)
    // and Chrome (Opus).
    try {
      mediaRecorder = new MediaRecorder(mediaStream, { mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 24000 });
    } catch {
      mediaRecorder = new MediaRecorder(mediaStream, { audioBitsPerSecond: 24000 });
    }
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunks.push(e.data); };
    // No timeslice — `start()` writes the complete webm container
    // (EBML header + segment + cluster + duration) to a single blob
    // on stop(). With timeslice, Chromium fragments the file into
    // segments that concatenate cleanly only on the FIRST recorder
    // instance per MediaStream lifetime; the second recorder's
    // segments produce a malformed container that Deepgram rejects.
    mediaRecorder.start();
  }

  armedAt = Date.now();
  // Initialise the silence window from current handsfree config.
  // tickSilence reads expired() each frame; setThreshold lets a live
  // settings flip propagate without us having to subscribe.
  const cfg = getHandsfreeConfig();
  silenceWindow = new SilenceWindow(cfg.silenceSec, armedAt);
  startSilenceLoop();
  // Sendword detector. Two source modes:
  //   - LOCAL engine: subscribe to the same BrowserSttProvider we just
  //     started for body transcription. One SR session per turn,
  //     shared event stream — no second instance racing for the mic.
  //   - SERVER engine: open a standalone SR session inside the
  //     detector (the original v0.397 path). The MediaRecorder blob
  //     doesn't expose realtime text, so we have no source to share.
  // listenSttEngine='silence-only' opts out of sendword detection in
  // both paths.
  const sendwordEngine = (settings.get() as any).listenSttEngine || 'local';
  if (cfg.sendwordPhrase && sendwordEngine !== 'silence-only') {
    sendwordDetector.start({
      phrase: cfg.sendwordPhrase,
      onMatch: () => commitFromSendword(),
      source: armedWithLocal && localProvider ? localProvider : undefined,
    });
  }
  transition('armed');
}

/** Stop + release the BrowserSttProvider, drop the transcript listener.
 *  Idempotent. Safe to call from the server-engine path (no-op when
 *  the provider was never created). */
async function teardownLocalProvider(): Promise<void> {
  if (localUnsub) {
    try { localUnsub(); } catch { /* noop */ }
    localUnsub = null;
  }
  if (localProvider) {
    try { await localProvider.stop(); } catch { /* noop */ }
    localProvider = null;
  }
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
  bargeWindow = new BargeWindow();  // defaults: 5 frames, 4 hot
  bargeMuteUntil = Date.now() + BARGE_WARMUP_MS;
  bargeLoop = setInterval(tickBarge, BARGE_FRAME_MS);
}

function stopBargeLoop(): void {
  if (bargeLoop) { clearInterval(bargeLoop); bargeLoop = null; }
  bargeWindow = null;
  bargeMuteUntil = 0;
}

/** One frame of barge detection. Algorithm in shared/barge.ts; this
 *  just provides the per-frame plumbing (warmup mute, settings kill
 *  switch, peak read from analyser, fire onBarge on a positive). */
function tickBarge(): void {
  if (state !== 'playing') return;
  if (!analyser || !bargeWindow) return;
  if (Date.now() < bargeMuteUntil) return;

  const s = settings.get();
  // PWA-side bargeIn setting acts as a kill switch for Listen too —
  // user toggling barge off in the menu disables here, same wire as
  // the WebRTC path (which sends barge_enabled in the offer).
  if (!(s as any).bargeIn) return;

  const peak = readPeak(analyser);
  // Device-class default lookup (voiceTuning) honoring the user's
  // slider override. Same threshold path the realtime barge uses, so
  // both modes barge at consistent peak levels per device.
  const threshold = getBargeThreshold();
  if (bargeWindow.push(peak, threshold)) {
    log(`listen: barge fire peak=${peak.toFixed(3)}`);
    stopBargeLoop();
    // Audible feedback — same chime realtime fires on barge so the
    // user hears a consistent "I heard you, stopping" cue across both
    // modes. Plays BEFORE the caller's onBarge runs so the user
    // doesn't hear silence between the agent's TTS being cut and the
    // re-arm chime that fires on next-turn re-arm.
    try { playFeedback('barge'); } catch { /* noop */ }
    try { opts?.onBarge?.(); } catch (e: any) {
      diag('listen: onBarge threw', e?.message);
    }
  }
}

/** One frame of silence detection. Reads peak from the analyser (or the
 *  injected mock-frame queue when a smoke test is driving us). The
 *  silenceWindow holds lastVoiceAt + threshold; when expired, fire
 *  commit. Threshold updates live via setThreshold so user changes
 *  propagate mid-session. */
function tickSilence(): void {
  if (state !== 'armed') return;
  if (!silenceWindow) return;
  const now = Date.now();
  if (now - armedAt < SILENCE_WARMUP_MS) {
    // Skip the warmup window so the "listening" chime + late mic
    // unmute don't get counted as silence.
    return;
  }

  // Re-read the threshold each frame so a settings flip takes effect
  // without us subscribing to the settings module.
  silenceWindow.setThreshold(getHandsfreeConfig().silenceSec);

  let isSpeech = false;
  if (mockFrames && mockFrames.remainingMs > 0) {
    isSpeech = mockFrames.type === 'speech';
    mockFrames.remainingMs -= SILENCE_FRAME_MS;
    if (mockFrames.remainingMs <= 0) mockFrames = null;
  } else if (analyser) {
    // Same device-aware threshold the barge loop uses — silence
    // detection has the same "is this speech or ambient?" question,
    // so the cutoff should match. Otherwise a mic that sits at 0.12
    // ambient on iOS BT would never trigger silence-end with a 0.10
    // global default.
    isSpeech = readPeak(analyser) > getBargeThreshold();
  }

  if (isSpeech) {
    silenceWindow.noteVoice(now);
    return;
  }
  if (silenceWindow.expired(now)) {
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

/** Internal: stop the recorder/provider, harvest the body (blob or
 *  text), fire onCommit/onCommitText per the active engine. */
async function commitNow(reason: 'silence' | 'sendword'): Promise<void> {
  if (state !== 'armed') return;
  transition('committing');
  stopSilenceLoop();
  try { sendwordDetector.stop(); } catch { /* noop */ }

  if (armedWithLocal) {
    // LOCAL path — pull the accumulated transcript from the provider.
    // Stop the provider FIRST so any in-flight final landing during
    // teardown still appends to localFinalText (the listener stays
    // active until teardownLocalProvider's unsub).
    // Pad the final text with the latest interim if no final landed
    // yet — Web Speech sometimes commits a long utterance only on
    // session end, and the silence detector beat us to it.
    const text = localFinalText
      || localLastInterim
      || '';
    await teardownLocalProvider();
    log(`listen: commit (${reason}) text="${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`);
    if (!text.trim()) {
      // Empty turn — re-arm directly without invoking the caller.
      armRecorder().catch(() => teardown());
      return;
    }
    try {
      const out = opts?.onCommitText?.(text.trim(), reason);
      if (out && typeof (out as Promise<void>).then === 'function') {
        await out;
      }
    } catch (e: any) {
      diag('listen: onCommitText threw', e?.message);
      armRecorder().catch(() => teardown());
      return;
    }
  } else {
    // SERVER path — harvest the MediaRecorder blob, ship to caller.
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
  // Release the local STT provider if we were running on the local
  // engine. Fire-and-forget — the await chain isn't worth the async
  // teardown signature change for downstream callers (cancel/stop are
  // declared sync and we don't want to break that contract).
  void teardownLocalProvider();
  localFinalText = '';
  localLastInterim = '';
  armedWithLocal = false;
  if (mediaStream) {
    audioPlatform.releaseMicStream('listen');
    mediaStream = null;
  }
  analyser = null;
  mockFrames = null;
  try { sendwordDetector.stop(); } catch { /* noop */ }
  // Tear down the visual recorder bar BEFORE transition('idle') so
  // the transition's analyser-detach logic (bar.attachAnalyser(null))
  // doesn't run on a destroyed bar.
  if (bar) {
    try { bar.destroy(); } catch { /* noop */ }
    bar = null;
  }
  transition('idle');
}

function transition(s: ListenState): void {
  if (state === s) return;
  state = s;
  try { opts?.onState?.(s); } catch { /* noop */ }
  // Sync the recorder bar's analyser to whether we're actively
  // capturing for transcription. Live waveform during 'armed' (mic
  // → blob), frozen during commit/playing/cooldown so the user
  // doesn't see motion that misrepresents capture state. The bar
  // itself stays mounted across all non-idle states.
  if (bar) {
    bar.attachAnalyser(s === 'armed' ? analyser : null);
  }
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
      // Pretend we never heard speech — wind lastVoiceAt back so the
      // configured silence window can elapse during the mock frame.
      silenceWindow?.noteVoice(Date.now() - durationMs);
    },
    injectSpeech(durationMs: number) {
      mockFrames = { type: 'speech', remainingMs: durationMs };
      silenceWindow?.noteVoice();
    },
    commit() { void commitNow('sendword'); },
  };
}
