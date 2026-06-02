/**
 * @fileoverview HTTP TTS playback for text-typed agent replies.
 *
 * Wired from `main.ts:handleReplyFinal` whenever `settings.tts` is on AND
 * a WebRTC call is NOT in progress (call mode owns audio end-to-end via
 * its own peer-track TTS). Fetches Deepgram Aura via the server's
 * `/tts` proxy and plays the returned mp3 through the shared `#player`
 * audio element. Cancellation is "last reply wins" — a fresh
 * `playReplyTts()` cancels any in-flight playback before starting.
 *
 * iOS gesture binding: the playback path needs a primed AudioContext to
 * actually emit sound on Mobile Safari. The send button handler already
 * touches mic/audio (via memo / dictate / call paths), and the global
 * pointerdown/keydown unlock at boot covers all other entry points.
 *
 * Text cleaning: re-implements the regex set from
 * `test/tts-clean.test.ts` (whose `cleanForTts` was once exported from
 * `src/pipelines/classic/tts.ts` — file is gone, regex set lives on in
 * the test as the canonical reference). Keep these in sync.
 *
 * Event emitter: classic ported pattern. Public events carry replyId in
 * payload so the per-bubble UX (replyPlayer.ts) can route updates by
 * bubble identity instead of relying on a shared global. Critical for
 * keeping the bubble's loading bar / playhead / glyph swap honest under
 * cancel/replay/skip operations. Subscribers register via on() and
 * unsubscribe via off(); call once at boot.
 */

import { log, diag } from '../../util/log.ts';
import * as replyCache from './replyCache.ts';
import * as settings from '../../settings.ts';
import * as audioSession from '../shared/session.ts';

// ── Public state machine + event surface ─────────────────────────────

export type TtsState = 'idle' | 'loading' | 'playing' | 'paused' | 'ended';

export type TtsEventName =
  | 'synth-start'      // fetch beginning (or cache-hit imminent); { replyId }
  | 'load-progress'    // buffer/synth ratio update; { replyId, ratio }
  | 'duration-known'   // metadata loaded, duration available; { replyId, duration }
  | 'play-start'       // audio begins playing (or resumes from idle); { replyId }
  | 'progress'         // playback position update; { replyId, position, duration }
  | 'seek'             // user scrubbed; { replyId, position, duration }
  | 'paused'           // mid-stream pause; { replyId }
  | 'resumed'          // resume from paused; { replyId }
  | 'ended'            // natural end-of-stream; { replyId }
  | 'stopped';         // canceled (replay, mode-switch, user); { replyId, reason }

type Handler = (payload: any) => void;
const handlers: Record<TtsEventName, Set<Handler>> = {
  'synth-start': new Set(),
  'load-progress': new Set(),
  'duration-known': new Set(),
  'play-start': new Set(),
  'progress': new Set(),
  'seek': new Set(),
  'paused': new Set(),
  'resumed': new Set(),
  'ended': new Set(),
  'stopped': new Set(),
};

export function on(name: TtsEventName, fn: Handler): void {
  handlers[name].add(fn);
}
export function off(name: TtsEventName, fn: Handler): void {
  handlers[name].delete(fn);
}
function emit(name: TtsEventName, payload: any): void {
  for (const fn of handlers[name]) {
    try { fn(payload); } catch (e: any) {
      diag(`[text-tts] subscriber to '${name}' threw:`, e?.message);
    }
  }
}

// ── State accessors ──────────────────────────────────────────────────

let activeReplyId: string | null = null;
let state: TtsState = 'idle';

/** Identifier of the reply currently being driven by playReplyTts. */
export function getActiveReplyId(): string | null { return activeReplyId; }

/** Current playback state. Drives the per-bubble UX glyph + bar
 *  decisions WITHOUT relying on the audio element's derived flags
 *  (audio.paused races audio.ended on natural end). */
export function getState(): TtsState { return state; }

/** Whether the active player is currently paused (vs idle vs playing). */
export function isPaused(): boolean { return state === 'paused'; }

function setState(next: TtsState): void {
  if (state === next) return;
  state = next;
}

// ── Active session bookkeeping ───────────────────────────────────────

/** Tracks the active fetch + playback so a follow-up reply can cancel
 *  it. Module-level singleton — only one text-mode TTS plays at a time
 *  per page (call-mode TTS is owned separately by the WebRTC peer
 *  track).
 *
 *  Two branches:
 *    - HTTP /tts (server engine): `audio` is the shared #player element,
 *      `abort` cancels the fetch.
 *    - speechSynthesis (local engine): `utterance` is the live
 *      SpeechSynthesisUtterance. `audio`/`abort` are absent. */
let active:
  | { kind: 'server'; audio: HTMLAudioElement; abort: AbortController }
  | { kind: 'local'; utterance: SpeechSynthesisUtterance }
  | null = null;

/** Player-element listeners are attached ONCE for the lifetime of the
 *  page. Each event re-emits as a typed event with the active replyId
 *  baked in, so subscribers (replyPlayer) don't have to chase the
 *  global. */
let playerListenersAttached = false;
function ensurePlayerListenersAttached(player: HTMLAudioElement): void {
  if (playerListenersAttached) return;
  playerListenersAttached = true;

  // Experiment #1 (v0.417): tried createMediaElementSource(player)
  // routing through the shared AudioContext to make Chrome's AEC see
  // the TTS output as part of the same graph as the Silero mic input.
  // RESULT: catastrophic — MicVAD.new() started taking ~40 seconds
  // instead of <1s when the player was wired into the same context,
  // breaking barge for BOTH realtime and turnbased modes. Reverted in
  // v0.418. The AEC + AudioContext interaction is not safely
  // composable with our AudioWorklet-based VAD load. See backlog.

  player.addEventListener('loadedmetadata', () => {
    if (!activeReplyId) return;
    const dur = player.duration;
    if (Number.isFinite(dur) && dur > 0) {
      emit('duration-known', { replyId: activeReplyId, duration: dur });
      // Blob URLs are 100% local — once metadata is in we know the
      // file is fully loadable. Mark loaded ratio as 1 so the loaded
      // bar can fill (replyPlayer translates load-progress).
      emit('load-progress', { replyId: activeReplyId, ratio: 1 });
    }
  });
  player.addEventListener('play', () => {
    if (!activeReplyId) return;
    if (state === 'paused') {
      setState('playing');
      emit('resumed', { replyId: activeReplyId });
    } else {
      setState('playing');
      emit('play-start', { replyId: activeReplyId });
    }
  });
  player.addEventListener('pause', () => {
    if (!activeReplyId) return;
    // Distinguish a real pause from end-of-stream: 'ended' fires AFTER
    // 'pause' on natural completion. The 'ended' listener handles the
    // ended branch; here we only flip to 'paused' if not actually ended.
    if (player.ended) return;
    if (state === 'playing') {
      setState('paused');
      emit('paused', { replyId: activeReplyId });
    }
  });
  player.addEventListener('ended', () => {
    if (!activeReplyId) return;
    setState('ended');
    const id = activeReplyId;
    // Auto-clear active session so the next click on the same bubble
    // starts a fresh playback (not a resume-already-finished no-op).
    if (active && active.kind === 'server' && active.audio === player) {
      active = null;
      activeReplyId = null;
    }
    emit('ended', { replyId: id });
    setState('idle');
  });
  player.addEventListener('timeupdate', () => {
    if (!activeReplyId) return;
    const dur = player.duration;
    const pos = player.currentTime;
    if (!Number.isFinite(dur) || dur <= 0) return;
    emit('progress', { replyId: activeReplyId, position: pos, duration: dur });
  });
}

// ── Public lifecycle API ─────────────────────────────────────────────

/** Pause the in-flight playback without tearing down the blob URL. */
export function pauseReplyTts(): void {
  if (!active) return;
  if (active.kind === 'server') {
    try { active.audio.pause(); } catch { /* noop */ }
    return;
  }
  // Local engine: speechSynthesis.pause(). iOS Safari support is
  // patchy (some versions return immediately or treat pause as
  // cancel) — best-effort, no error surfacing if it fails to honor.
  try { speechSynthesis.pause(); } catch { /* noop */ }
  // Manually fire `paused` since speechSynthesis doesn't have a
  // separate "pause-fired" event we can lean on (utterance only
  // fires start/end/error/boundary). State drives the UI here.
  if (state === 'playing' && activeReplyId) {
    setState('paused');
    emit('paused', { replyId: activeReplyId });
  }
}

/** Resume previously-paused playback. */
export async function resumeReplyTts(): Promise<void> {
  if (!active) return;
  if (active.kind === 'server') {
    try { await active.audio.play(); } catch { /* noop */ }
    return;
  }
  try { speechSynthesis.resume(); } catch { /* noop */ }
  if (state === 'paused' && activeReplyId) {
    setState('playing');
    emit('resumed', { replyId: activeReplyId });
  }
}

/** Replay the current reply from the start. Returns false if there's
 *  no active session (caller falls back to a fresh playReplyTts). */
export async function replay(): Promise<boolean> {
  if (!active) return false;
  if (active.kind === 'server') {
    try {
      active.audio.currentTime = 0;
      setState('playing');
      await active.audio.play();
      if (activeReplyId) emit('play-start', { replyId: activeReplyId });
      return true;
    } catch {
      return false;
    }
  }
  // Local engine has no rewind primitive — caller should re-invoke
  // playReplyTts with the same text. Returning false signals that.
  return false;
}

/** Seek to a fractional position [0, 1] within the current reply.
 *  No-op when nothing's loaded. Emits 'seek' so the played-ratio bar
 *  jumps in lockstep. */
export function seekTo(ratio: number): void {
  if (!active) return;
  // Local engine has no seek — speechSynthesis is monolithic. No-op.
  if (active.kind !== 'server') return;
  const r = Math.max(0, Math.min(1, ratio));
  const dur = active.audio.duration;
  if (!Number.isFinite(dur) || dur <= 0) return;
  const pos = r * dur;
  try { active.audio.currentTime = pos; } catch { /* noop */ }
  if (activeReplyId) {
    emit('seek', { replyId: activeReplyId, position: pos, duration: dur });
  }
}

/** Strip markdown / URLs / emoji that don't read well when synthesized.
 *  Kept in lock-step with `test/tts-clean.test.ts`. */
function cleanForTts(text: string): string {
  let t = text;
  t = t.replace(/^\[[A-Za-z0-9_\- ]+\]\s*/, '');
  t = t.replace(/```[\s\S]*?```/g, '[code block]');
  t = t.replace(/`([^`]+)`/g, '$1');
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,!?)]|$)/g, '$1$2');
  t = t.replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,!?)]|$)/g, '$1$2');
  t = t.replace(/^[\s]*[-*•]\s+/gm, '');
  t = t.replace(/^#+\s+/gm, '');
  t = t.replace(/https?:\/\/[^\s<)\]"']+/g, '(link in canvas)');
  t = t.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu, '');
  t = t.replace(/\*/g, '');
  t = t.replace(/^[#\-\s]+$/gm, '');
  t = t.replace(/\s+/g, ' ').trim();
  // /tts server caps at 2000 chars; stay under to leave headroom.
  return t.slice(0, 1800);
}

/** Cancel any in-flight TTS fetch + playback. Safe to call when idle. */
export function cancelReplyTts(reason: string = 'cancel'): void {
  if (!active) {
    diag(`[reply-tts] cancel skip (idle, reason=${reason})`);
    return;
  }
  const id = activeReplyId;
  diag(`[reply-tts] cancel reason=${reason} prevReplyId=${id} prevState=${state} kind=${active.kind}`);
  if (active.kind === 'server') {
    try { active.abort.abort(); } catch { /* noop */ }
    try {
      active.audio.pause();
      if (active.audio.src) {
        try { URL.revokeObjectURL(active.audio.src); } catch { /* noop */ }
        active.audio.removeAttribute('src');
        active.audio.load();
      }
    } catch { /* noop */ }
  } else {
    // Local engine — speechSynthesis.cancel() flushes the queue and
    // stops the current utterance. Triggers `onend` on the active
    // utterance which we've already nulled out via our reason guard
    // below; that's fine, the listener checks active === this entry.
    try { speechSynthesis.cancel(); } catch { /* noop */ }
  }
  active = null;
  activeReplyId = null;
  setState('idle');
  if (id) emit('stopped', { replyId: id, reason });
}

/** Synthesize + play `text` through the page's `#player` element.
 *  Best-effort: returns a resolved Promise on success or after a
 *  cancellation; rejects only on hard errors the caller may want to
 *  log. */
export async function playReplyTts(
  rawText: string,
  voice: string,
  replyId?: string,
): Promise<void> {
  const engine = settings.get().ttsEngine || 'server';
  const text = cleanForTts(rawText || '');
  diag(`[reply-tts] enter replyId=${replyId} rawLen=${(rawText || '').length} cleanLen=${text.length} voice=${voice} engine=${engine}`);
  if (!text) {
    diag('[reply-tts] skip (clean text empty)');
    return;
  }

  // Engine selector. Local = speechSynthesis (on-device, no /tts hop).
  // Server = HTTP /tts (Deepgram Aura, default). Both fan in to the
  // same event surface so subscribers (replyPlayer.ts) don't care which
  // engine is active.
  if (settings.get().ttsEngine === 'local') {
    return playLocalTts(text, replyId);
  }

  cancelReplyTts('superseded');

  const player = document.getElementById('player') as HTMLAudioElement | null;
  if (!player) {
    diag('[text-tts] no #player element — skipping');
    return;
  }
  ensurePlayerListenersAttached(player);

  const abort = new AbortController();
  active = { kind: 'server', audio: player, abort };
  activeReplyId = replyId || null;
  setState('loading');

  if (activeReplyId) emit('synth-start', { replyId: activeReplyId });

  let blobUrl: string | null = null;
  try {
    let blob = replyCache.get(text, voice);
    if (!blob) {
      const res = await fetch('/tts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, model: voice }),
        signal: abort.signal,
      });
      if (!res.ok) {
        diag(`[text-tts] /tts ${res.status}`);
        // Reset state so the user can retry. Pre-fix the error path only
        // emitted 'stopped' but left state='loading' + active set, which
        // wedged the play-btn: replyPlayer.ts's loading-guard dropped
        // every subsequent tap with "[reply-player] click ignored
        // (loading)." Without this fix, a /tts error leaves the play-btn dead.
        cancelReplyTts('tts-http-error');
        return;
      }
      blob = await res.blob();
      if (abort.signal.aborted) return;
      replyCache.set(text, voice, blob);
    }
    blobUrl = URL.createObjectURL(blob);
    player.src = blobUrl;
    // Drop any prior peer-track binding so the blob takes over.
    player.srcObject = null;
    // iOS: HTMLAudioElement.play() inherits the AVAudioSession category at
    // play() time. Turn-mode TTS fires while the session is still
    // 'play-and-record' (from the listen-mode mic capture), which routes
    // output to the iPhone earpiece instead of connected BT — inaudible
    // on a headset. Hint 'playback' first so it routes to BT A2DP. iOS
    // keeps mic capture alive since the session started in play-and-record.
    audioSession.prepareForPlayback();
    await player.play();
    log(`[text-tts] playing ${text.length} chars`);
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    diag(`[text-tts] failed: ${e?.message || e}`);
    // Same reason as the !res.ok branch — reset state so retry works.
    cancelReplyTts('play-error');
  }
  // NOTE: do NOT clear `active` in a finally block. play() resolves
  // when audio STARTS, not when it ends. The 'ended' listener clears
  // active + activeReplyId on natural end.
}

/** Local TTS via speechSynthesis. Runs entirely in-browser — no /tts
 *  HTTP hop, no Deepgram, no server. Useful when the bridge isn't
 *  reachable (offline, dev without bridge running) but the agent text
 *  reply is still arriving over HTTP.
 *
 *  iOS gotchas (documented inline so future readers don't relearn):
 *    - speechSynthesis.pause() is unreliable on iOS Safari (some
 *      versions ignore it; some treat it as cancel). UI offers the
 *      pause button anyway because cancel-and-replay is a viable
 *      fallback.
 *    - speechSynthesis.cancel() is required as the FIRST line of
 *      every fresh speak — iOS Safari's queue isn't auto-cleared on
 *      a new utterance and old ones can stall the new one indefinitely.
 *    - The voice list (speechSynthesis.getVoices) often arrives
 *      asynchronously after `voiceschanged` fires. settings.ts already
 *      handles this for the picker; here we accept whatever's loaded
 *      at speak time and fall back to system default if the chosen
 *      voice has been GC'd.
 *    - Some iOS versions silently drop utterances ≥ ~32k chars; cleaned
 *      text is already capped at 1800 chars by cleanForTts so we're
 *      safe. */
function playLocalTts(text: string, replyId?: string): Promise<void> {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') {
    diag('[text-tts] local engine selected but speechSynthesis unavailable');
    if (replyId) emit('stopped', { replyId, reason: 'tts-unsupported' });
    return Promise.resolve();
  }

  cancelReplyTts('superseded');

  const utt = new SpeechSynthesisUtterance(text);
  // Voice picker (settings.ttsVoiceLocal) selects by `name`. Empty
  // string = "system default" — leave utt.voice null so the engine
  // picks. Filter the voice list at speak time so a freshly-loaded
  // voice catalog after the picker rendered still works.
  const wantedName = String((settings.get() as any).ttsVoiceLocal || '').trim();
  if (wantedName) {
    try {
      const voices = speechSynthesis.getVoices() || [];
      const match = voices.find(v => v.name === wantedName);
      if (match) utt.voice = match;
    } catch { /* getVoices can throw on cold-load in some browsers; default voice is fine */ }
  }

  active = { kind: 'local', utterance: utt };
  activeReplyId = replyId || null;
  setState('loading');
  if (activeReplyId) emit('synth-start', { replyId: activeReplyId });

  utt.onstart = () => {
    if (!activeReplyId || active?.kind !== 'local' || active.utterance !== utt) return;
    setState('playing');
    emit('play-start', { replyId: activeReplyId });
  };
  utt.onend = () => {
    // Guard: if this utterance was cancelled and superseded, the new
    // session already cleared `active`. Don't double-fire `ended`.
    if (active?.kind !== 'local' || active.utterance !== utt) return;
    setState('ended');
    const id = activeReplyId;
    active = null;
    activeReplyId = null;
    if (id) emit('ended', { replyId: id });
    setState('idle');
  };
  utt.onerror = (e: any) => {
    if (active?.kind !== 'local' || active.utterance !== utt) return;
    diag('[text-tts] local utterance error:', e?.error || e?.message);
    const id = activeReplyId;
    active = null;
    activeReplyId = null;
    setState('idle');
    if (id) emit('stopped', { replyId: id, reason: 'tts-error' });
  };

  try {
    // Belt-and-braces: cancel any orphaned utterances in the queue
    // before queueing the new one. iOS Safari occasionally strands
    // utterances on visibility flips; this clears the slate.
    speechSynthesis.cancel();
    speechSynthesis.speak(utt);
    log(`[text-tts] local speak ${text.length} chars (voice=${utt.voice?.name || 'default'})`);
  } catch (e: any) {
    diag(`[text-tts] local speak threw: ${e?.message || e}`);
    if (activeReplyId) emit('stopped', { replyId: activeReplyId, reason: 'tts-error' });
    active = null;
    activeReplyId = null;
    setState('idle');
  }
  return Promise.resolve();
}
