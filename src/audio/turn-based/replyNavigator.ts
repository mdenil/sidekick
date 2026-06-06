/**
 * @fileoverview Per-reply navigation pointer for BT skip-fwd / skip-back.
 *
 * Wired in `src/main.ts` onNextTrack / onPrevTrack via session.ts.
 *
 * The DOM-class flips, loading bar, played-ratio bar, scrub, and
 * play/pause/replay button all live in `replyPlayer.ts` (delegated
 * handlers driven by `tts.ts` events). This module is intentionally
 * thin: it owns ONLY the "what bubble does BT skip-fwd/back act on"
 * pointer + the navigation algorithm.
 *
 * Pointer model: `currentBubble` defaults to the most-recent agent
 * bubble. Updated whenever a fresh playback starts on a specific bubble
 * (via `tts.ts:play-start` event). Reset on chat switch via `reset()`.
 */

import { log } from '../../util/log.ts';
import * as tts from './tts.ts';

let currentBubble: HTMLElement | null = null;
let subscribed = false;

async function resolveVoice(): Promise<string> {
  try {
    const settingsMod = await import('../../settings.ts');
    // BT skip-fwd/back navigates the viewed session's bubbles, so prefer
    // that session's assigned voice (sessionIdentity) over the default.
    const identMod = await import('../../sessionIdentity.ts');
    const switchMod = await import('../../switchController.ts');
    const sid = switchMod.viewedId?.() || '';
    const v = identMod.voiceFor?.(sid) || settingsMod.get?.()?.voice;
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

/** Subscribe once to tts.play-start so the pointer follows playback.
 *  Without this, BT skip-fwd would always start from the most-recent
 *  bubble even after the user drove playback to a middle reply. */
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  tts.on('play-start', ({ replyId }: { replyId: string }) => {
    const b = findBubbleByReplyId(replyId);
    if (b) currentBubble = b;
  });
}

/** Public: play the agent bubble BEFORE the current pointer. */
export async function playPrev(): Promise<void> {
  ensureSubscribed();
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
  await playBubble(target);
}

/** Public: play the agent bubble AFTER the current pointer. */
export async function playNext(): Promise<void> {
  ensureSubscribed();
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
  await playBubble(target);
}

async function playBubble(bubble: HTMLElement): Promise<void> {
  const replyId = bubble.dataset.replyId || '';
  const text = (bubble.dataset.text || bubble.textContent || '').trim();
  if (!text) return;
  currentBubble = bubble;
  const voice = await resolveVoice();
  // playReplyTts internally cancels any prior session before starting.
  // The 'play-start' event will land in replyPlayer, which paints the
  // bubble's tts-active / tts-playing classes.
  await tts.playReplyTts(text, voice, replyId || undefined);
}

/** Public: stop playback + reset the pointer. Called on chat switch. */
export function reset(): void {
  tts.cancelReplyTts('reset');
  currentBubble = null;
}
