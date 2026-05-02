/**
 * @fileoverview Per-reply navigation engine + bubble playback state machine.
 *
 * Two surfaces consume this:
 *   1. MediaSession action handlers (BT skip-fwd / skip-back) — wired
 *      in src/main.ts onNextTrack / onPrevTrack via session.ts.
 *   2. Per-bubble play/pause chip on each agent message bubble —
 *      wired in src/chat.ts:addLine via a click handler that calls
 *      `togglePlayback(bubble)`.
 *
 * Playback transport is `src/audio/text-tts.ts` (cache-backed `/tts`
 * blob playback through the shared `#player` audio element).
 *
 * Bubble state machine (driven by listening to player events on
 * `#player` and tracking the active bubble):
 *
 *   idle      → no playback. Click → start (loading → playing).
 *   loading   → fetch in flight or audio buffering. Click → cancel.
 *   playing   → audio playing through speakers. Click → pause.
 *   paused    → audio paused mid-stream. Click → resume.
 *   played    → audio finished naturally. Click → restart from 0.
 *
 * State is reflected on the bubble via CSS classes:
 *   `.tts-cached` — cache hit available (faster start). Set by
 *                   syncCachedBadges() against replyCache.
 *   `.tts-active` — this bubble is the player's current focus.
 *   `.tts-playing` — audio currently sounding (CSS swaps play→pause glyph).
 *   `.tts-paused` — audio loaded but paused (mid-stream).
 *   `.tts-played` — audio finished naturally (icon back to play).
 *   `.tts-streaming` — fetch in progress (loading-bar shimmer).
 *
 * Pointer model: `currentBubble` tracks "what BT skip-back/skip-forward
 * acts relative to." Defaults to most-recent agent bubble. Updated
 * whenever playback starts on a specific bubble. Reset on chat switch
 * via `reset()`.
 */

import { log, diag } from '../../util/log.ts';
import {
  playReplyTts,
  pauseReplyTts,
  resumeReplyTts,
  cancelReplyTts,
  isPaused,
  getActiveReplyId,
} from './tts.ts';
import * as replyCache from './replyCache.ts';

let currentBubble: HTMLElement | null = null;
let playerListenersAttached = false;

async function resolveVoice(): Promise<string> {
  try {
    const settingsMod = await import('../../settings.ts');
    const v = settingsMod.get?.()?.voice;
    return typeof v === 'string' && v ? v : 'aura-2-thalia-en';
  } catch {
    return 'aura-2-thalia-en';
  }
}

function listAgentBubbles(): HTMLElement[] {
  const transcript = document.getElementById('transcript');
  if (!transcript) return [];
  return Array.from(transcript.querySelectorAll<HTMLElement>('.line.agent'));
}

function findBubbleByReplyId(replyId: string | null): HTMLElement | null {
  if (!replyId) return null;
  const transcript = document.getElementById('transcript');
  if (!transcript) return null;
  return transcript.querySelector<HTMLElement>(
    `.line.agent[data-reply-id="${CSS.escape(replyId)}"]`,
  );
}

function clearAllStateClasses(except?: HTMLElement | null): void {
  const transcript = document.getElementById('transcript');
  if (!transcript) return;
  transcript.querySelectorAll('.line.agent').forEach((el) => {
    if (el === except) return;
    el.classList.remove('tts-active', 'tts-playing', 'tts-paused', 'tts-streaming');
  });
}

/** Apply the right CSS class set to a bubble based on the named state.
 *  All other transient classes are cleared first so transitions are
 *  atomic — no half-rendered "playing AND paused" combos. */
function setBubbleState(
  bubble: HTMLElement,
  state: 'idle' | 'loading' | 'playing' | 'paused' | 'played',
): void {
  bubble.classList.remove('tts-active', 'tts-playing', 'tts-paused', 'tts-streaming', 'tts-played');
  if (state === 'loading') bubble.classList.add('tts-active', 'tts-streaming');
  else if (state === 'playing') bubble.classList.add('tts-active', 'tts-playing');
  else if (state === 'paused') bubble.classList.add('tts-active', 'tts-paused');
  else if (state === 'played') bubble.classList.add('tts-played');
}

/** Hook player events ONCE so any number of plays/pauses get reflected
 *  back into the active bubble's CSS classes. Idempotent. */
function ensurePlayerListenersAttached(): void {
  if (playerListenersAttached) return;
  const player = document.getElementById('player') as HTMLAudioElement | null;
  if (!player) return;
  playerListenersAttached = true;

  const findActive = () => findBubbleByReplyId(getActiveReplyId());

  player.addEventListener('play', () => {
    const b = findActive();
    if (b) {
      currentBubble = b;
      setBubbleState(b, 'playing');
      clearAllStateClasses(b);
    }
  });
  player.addEventListener('pause', () => {
    const b = findActive();
    if (!b) return;
    // Distinguish real pause from end-of-stream pause. `ended` event
    // fires AFTER pause for natural completion; treat that as 'played'.
    if (player.ended) setBubbleState(b, 'played');
    else if (player.currentTime > 0) setBubbleState(b, 'paused');
  });
  player.addEventListener('ended', () => {
    const b = findActive();
    if (b) setBubbleState(b, 'played');
  });
  player.addEventListener('loadstart', () => {
    const b = findActive();
    if (b) setBubbleState(b, 'loading');
  });
  player.addEventListener('error', () => {
    const b = findActive();
    if (b) setBubbleState(b, 'idle');
  });
  // Advance the played-ratio bar in lockstep with playback. Cheap —
  // <audio> fires timeupdate ~4×/sec by default, well below CSS
  // transition cost. Skip work when no active bubble.
  player.addEventListener('timeupdate', () => {
    const b = findActive();
    if (!b) return;
    const dur = player.duration;
    const pos = player.currentTime;
    if (!Number.isFinite(dur) || dur <= 0) return;
    setPlayedRatio(b, pos / dur);
  });
  // Once metadata loads we know the duration → mark loaded bar full
  // (we have the whole blob locally; "loaded" reflects buffering
  // progress which is N/A for blob URLs — they're 100% loaded).
  player.addEventListener('loadedmetadata', () => {
    const b = findActive();
    if (b) setLoadedRatio(b, 1);
  });
}

function setLoadedRatio(bubble: HTMLElement, ratio: number): void {
  const el = bubble.querySelector('.play-bar-loaded') as HTMLElement | null;
  if (el) el.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

function setPlayedRatio(bubble: HTMLElement, ratio: number): void {
  const el = bubble.querySelector('.play-bar-played') as HTMLElement | null;
  if (el) el.style.width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
}

/** Mark cached-vs-uncached state on every visible agent bubble. Called
 *  by chat.ts after rendering (or after a cache update event). */
export function syncCachedBadges(): void {
  // Cache lookup needs the (text, voice) pair; voice is global, text
  // is on each bubble's data-text. We can't preflight without voice,
  // so just check by text alone and assume the current voice. Cheap.
  resolveVoice().then((voice) => {
    listAgentBubbles().forEach((b) => {
      const text = (b.dataset.text || b.textContent || '').trim();
      // Cache key uses cleanForTts; mirror that minimally — for badge
      // accuracy we only need a "very likely cached" signal, not exact.
      // First-pass: just consult cache.has on the raw text. Misses
      // are visible regressions only on edge-case text mutations.
      if (text && replyCache.has(text, voice)) {
        b.classList.add('tts-cached');
      } else {
        b.classList.remove('tts-cached');
      }
    });
  });
}

/** Click handler for a per-bubble play/pause chip. Resolves the right
 *  action based on this bubble's current state vs. the active player. */
export async function togglePlayback(bubble: HTMLElement): Promise<void> {
  if (!bubble) return;
  ensurePlayerListenersAttached();
  const replyId = bubble.dataset.replyId || '';
  const text = (bubble.dataset.text || '').trim();
  if (!text) {
    diag('[reply-nav] bubble has no text — skipping');
    return;
  }
  const activeId = getActiveReplyId();

  // Case 1: this bubble IS the active one — toggle pause/resume.
  if (activeId && activeId === replyId) {
    if (isPaused()) {
      log('[reply-nav] resume');
      await resumeReplyTts();
      // The 'play' event handler will set 'tts-playing' class.
    } else {
      log('[reply-nav] pause');
      pauseReplyTts();
      // The 'pause' event handler will set 'tts-paused' class.
    }
    return;
  }

  // Case 2: a DIFFERENT bubble is active — cancel + start this one.
  // Or no active bubble — just start.
  currentBubble = bubble;
  const voice = await resolveVoice();
  // playReplyTts internally cancels any prior session before starting
  // — no need to call cancelReplyTts here.
  await playReplyTts(text, voice, replyId || undefined);
}

/** Public: replay specific bubble — kept for backward-compat with the
 *  earlier API. Now just an alias for togglePlayback. */
export async function playSpecific(bubble: HTMLElement): Promise<void> {
  return togglePlayback(bubble);
}

/** Public: play the agent bubble BEFORE the current pointer. */
export async function playPrev(): Promise<void> {
  const all = listAgentBubbles();
  if (!all.length) return;
  const cur = currentBubble && document.body.contains(currentBubble)
    ? currentBubble : all[all.length - 1];
  const idx = all.indexOf(cur);
  const target = idx > 0 ? all[idx - 1] : null;
  if (!target) {
    log('[reply-nav] already at first reply');
    return;
  }
  return togglePlayback(target);
}

/** Public: play the agent bubble AFTER the current pointer. */
export async function playNext(): Promise<void> {
  const all = listAgentBubbles();
  if (!all.length) return;
  const cur = currentBubble && document.body.contains(currentBubble)
    ? currentBubble : all[all.length - 1];
  const idx = all.indexOf(cur);
  const target = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;
  if (!target) {
    log('[reply-nav] already at most-recent reply');
    return;
  }
  return togglePlayback(target);
}

/** Public: stop playback + clear all visual marks. Called on chat
 *  switch / hard reset. */
export function reset(): void {
  cancelReplyTts();
  const transcript = document.getElementById('transcript');
  if (transcript) {
    transcript.querySelectorAll('.line.agent').forEach((el) => {
      el.classList.remove('tts-active', 'tts-playing', 'tts-paused', 'tts-streaming', 'tts-played');
    });
  }
  currentBubble = null;
}
