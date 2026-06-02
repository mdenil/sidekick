/**
 * Listen-mode reply autoplay + TTS-ownership state.
 *
 * Two concerns, one small module because they're coupled by the same
 * "Listen owns this reply's audio" lifecycle:
 *
 *  1. Awaiting-reply window — when a Listen turn commits we record which
 *     chat we're expecting a reply for and when. The next reply_final on
 *     that chat, within the window and while turnbased is still
 *     committing/cooling-down, is eligible for autoplay.
 *
 *  2. TTS ownership — once an autoplay starts, the TTS→Listen bridge
 *     handlers must be scoped to THAT reply's id. A stale TTS event for a
 *     superseded reply (e.g. the 'stopped' emitted when playReplyTts
 *     cancels a paused-by-barge prior reply) must NOT drop ownership of
 *     the new reply. Without this scoping a barge-pause of reply #1
 *     followed by reply #2's autoplay muted TTS for the rest of a Listen
 *     call (the superseded-'stopped' for #1 flipped the old single boolean
 *     false after #2 had claimed ownership).
 */

import * as turnbased from './audio/turn-based/turnbased.ts';

const AUTOPLAY_WINDOW_MS = 2 * 60 * 1000;

let awaitingReplyChatId: string | null = null;
let awaitingReplyAt = 0;
let ttsOwned = false;
let ownedReplyId: string | null = null;

export function markAwaitingReply(chatId: string | null): void {
  if (!chatId) return;
  awaitingReplyChatId = chatId;
  awaitingReplyAt = Date.now();
}

export function shouldAutoPlay(conversation: string | undefined | null): boolean {
  if (!conversation || conversation !== awaitingReplyChatId) return false;
  if (Date.now() - awaitingReplyAt > AUTOPLAY_WINDOW_MS) return false;
  // The awaiting-chat-id + window + consume-once guard above already scopes
  // autoplay to exactly the reply this turn is waiting for. Do NOT additionally
  // gate on a transient turn state (committing/cooldown): on a slow link the
  // reply lands after the turn machine has re-armed ('armed'), and an extra
  // state check silently drops TTS — a regression from 2e82220 that
  // over-narrowed the gate.
  return turnbased.getState() !== 'idle';
}

export function consumeReply(chatId: string): void {
  if (awaitingReplyChatId === chatId) {
    awaitingReplyChatId = null;
    awaitingReplyAt = 0;
  }
}

/** Listen claims the audio for `replyId`'s autoplay. */
export function claimOwnership(replyId: string | null): void {
  ttsOwned = true;
  ownedReplyId = replyId;
}

/** Drop ownership (autoplay ended, paused, stopped, or failed). */
export function releaseOwnership(): void {
  ttsOwned = false;
  ownedReplyId = null;
}

/** True when a TTS event payload belongs to the reply Listen currently
 *  owns — used to ignore stale events for superseded replies. */
export function ownsReply(p: any): boolean {
  return ttsOwned && !!p?.replyId && p.replyId === ownedReplyId;
}
