/**
 * @fileoverview Per-reply navigation engine.
 *
 * Single source of truth for "play reply N" / "play next reply" / "play
 * previous reply" actions. Two surfaces consume it:
 *   1. MediaSession action handlers (BT skip-forward / skip-back). Wired
 *      in src/audio/session.ts. Lets headphone controls navigate the
 *      conversation hands-free.
 *   2. Per-bubble play-icon click in agent message bubbles. Wired in
 *      src/chat.ts via a small click handler on the appended chip.
 *
 * Both surfaces ultimately call into `src/audio/text-tts.ts:playReplyTts`,
 * which is already cache-backed (LRU MP3 Blob) — repeated playback of
 * the same `(text, voice)` pair is instant and free of extra Deepgram
 * cost. Realtime mode users get the same engine: a click fires HTTP /tts
 * even though the original audio came over the WebRTC peer track.
 *
 * Pointer model: an implicit "currently selected" agent bubble. By
 * default it's the most-recent one in the visible transcript. Calling
 * `playPrev()` walks backward; `playNext()` walks forward. The pointer
 * resets to "most recent" on chat switch (the transcript is rebuilt
 * by main.ts:replaySessionMessages so all DOM refs invalidate).
 *
 * Visual feedback: while a reply is playing, the corresponding bubble
 * gets a `.replaying` class. Caller's CSS owns the highlight (subtle
 * border or chip animation — pick what fits the rest of the chat).
 */

import { log, diag } from '../util/log.ts';
import { playReplyTts, cancelReplyTts } from './text-tts.ts';

// Module-private pointer to the currently-selected/playing agent bubble.
// `null` = no selection yet (defaults to most-recent on next call).
let currentBubble: HTMLElement | null = null;

/** Lazy resolver for the voice to feed into playReplyTts. We import
 *  settings inside the function (not at module top) so a circular
 *  import doesn't bite — settings.ts is heavy and we only need one
 *  field. */
async function resolveVoice(): Promise<string> {
  try {
    const settingsMod = await import('../settings.ts');
    const v = settingsMod.get?.()?.voice;
    return typeof v === 'string' && v ? v : 'aura-2-thalia-en';
  } catch {
    return 'aura-2-thalia-en';
  }
}

/** All `.line.agent` bubbles in document order. Transient — query each
 *  call so DOM mutations between calls (new agent reply, history load)
 *  are picked up automatically. */
function listAgentBubbles(): HTMLElement[] {
  const transcript = document.getElementById('transcript');
  if (!transcript) return [];
  return Array.from(transcript.querySelectorAll<HTMLElement>('.line.agent'));
}

/** Bubble the navigator should "currently" be playing. Falls back to
 *  the most-recent agent bubble when the pointer is unset / stale. */
function resolveCurrentBubble(): HTMLElement | null {
  if (currentBubble && document.body.contains(currentBubble)) {
    return currentBubble;
  }
  const all = listAgentBubbles();
  return all[all.length - 1] || null;
}

/** Visually mark the bubble as "now playing" — adds .replaying to it
 *  and removes from any previously-marked sibling. CSS owns the look. */
function markPlaying(bubble: HTMLElement | null): void {
  const transcript = document.getElementById('transcript');
  if (transcript) {
    transcript.querySelectorAll('.line.agent.replaying').forEach((el) => {
      if (el !== bubble) el.classList.remove('replaying');
    });
  }
  if (bubble) bubble.classList.add('replaying');
}

/** Internal: play a specific bubble's text. Sets the pointer, marks
 *  the bubble visually, hands off to text-tts (cache-backed). */
async function playBubble(bubble: HTMLElement | null): Promise<void> {
  if (!bubble) {
    diag('[reply-nav] no agent bubble to play');
    return;
  }
  const text = (bubble.dataset.text || bubble.textContent || '').trim();
  if (!text) {
    diag('[reply-nav] agent bubble has no text — skipping');
    return;
  }
  currentBubble = bubble;
  markPlaying(bubble);
  const voice = await resolveVoice();
  // Best-effort. text-tts handles its own cancel-and-replace on a
  // second call; failures (network / no /tts) log but don't throw past
  // the caller (BT action handler / chip click). Listener clears the
  // visual mark on `ended`/`error` via the player element, set up here.
  const player = document.getElementById('player') as HTMLAudioElement | null;
  const cleanup = () => {
    bubble.classList.remove('replaying');
    player?.removeEventListener('ended', cleanup);
    player?.removeEventListener('error', cleanup);
  };
  player?.addEventListener('ended', cleanup);
  player?.addEventListener('error', cleanup);
  try {
    await playReplyTts(text, voice);
    log(`[reply-nav] play ${text.length} chars`);
  } catch (e: any) {
    diag(`[reply-nav] failed: ${e?.message || e}`);
    cleanup();
  }
}

/** Public: replay the bubble we last navigated to (or the most recent
 *  if the pointer isn't set yet). Called by the per-bubble play chip
 *  with a specific bubble, OR by the BT play action with none. */
export async function playSpecific(bubble: HTMLElement): Promise<void> {
  return playBubble(bubble);
}

/** Public: play the agent bubble BEFORE the current pointer. If the
 *  pointer is at the first bubble, no-op. */
export async function playPrev(): Promise<void> {
  const all = listAgentBubbles();
  if (!all.length) return;
  const cur = resolveCurrentBubble();
  const idx = cur ? all.indexOf(cur) : all.length - 1;
  const target = idx > 0 ? all[idx - 1] : null;
  if (!target) {
    log('[reply-nav] already at first reply');
    return;
  }
  return playBubble(target);
}

/** Public: play the agent bubble AFTER the current pointer. If the
 *  pointer is at the last bubble, no-op. */
export async function playNext(): Promise<void> {
  const all = listAgentBubbles();
  if (!all.length) return;
  const cur = resolveCurrentBubble();
  const idx = cur ? all.indexOf(cur) : all.length - 1;
  const target = idx >= 0 && idx < all.length - 1 ? all[idx + 1] : null;
  if (!target) {
    log('[reply-nav] already at most-recent reply');
    return;
  }
  return playBubble(target);
}

/** Public: cancel any in-flight replay and clear visual marks. Called
 *  on session switch / hard reset to avoid a stale .replaying highlight
 *  on the wrong transcript. */
export function reset(): void {
  cancelReplyTts();
  const transcript = document.getElementById('transcript');
  if (transcript) {
    transcript.querySelectorAll('.line.agent.replaying').forEach((el) => {
      el.classList.remove('replaying');
    });
  }
  currentBubble = null;
}
