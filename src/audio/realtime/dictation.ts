/**
 * @fileoverview Per-call dictation state machine — owns the utterance
 * buffer, silence timer, and commit-phrase regex that used to live in
 * the audio bridge. The bridge is now a thin transcript pass-through;
 * the PWA decides when an utterance is "done" and tells the bridge to
 * dispatch it via the data channel.
 *
 * Inputs (every is_final user transcript from the bridge):
 *   handleUserFinal(text)
 *
 * Triggers that fire a dispatch:
 *   1. Silence timeout — `settings.silenceSec` seconds without a new
 *      is_final.  silenceSec=0 disables (waits forever for a commit
 *      phrase).
 *   2. Commit-phrase match — utterance ends in the configured phrase
 *      (e.g. "over"); the phrase is stripped and the rest is sent.
 *
 * On dispatch:
 *   - Clear the buffer.
 *   - connection.dispatch(text) — bridge POSTs to /api/hermes/responses.
 *   - onUserBubble(text) — caller renders the user bubble locally
 *     (one utterance = one bubble = one dispatch).
 *
 * On call close, callers must invoke reset() so a stale buffer doesn't
 * survive into the next call.
 */

import * as conn from './realtime.ts';
import * as callCapture from './callCapture.ts';
import { playFeedback } from '../shared/feedback.ts';
import { matchSendword, getHandsfreeConfig } from '../shared/handsfree.ts';
import { stitchTranscripts } from '../shared/chunkedTranscribe.ts';
import { log, diag } from '../../util/log.ts';

/** Cap on how long the FIRST dispatch of a call waits for the
 *  cold-start head transcript. Past this, dispatch un-spliced —
 *  better a clipped message than a stuck one. */
const HEAD_WAIT_MS = 4000;

let buffer: string[] = [];
let silenceTimer: ReturnType<typeof setTimeout> | null = null;
let onUserBubble: ((text: string) => void) | null = null;
let onReset: (() => void) | null = null;
let userMessageIdProvider: (() => string) | null = null;

/** Caller registers a handler that renders the user bubble (and any
 *  other "utterance committed" UI) at dispatch time. */
export function setUserBubbleHandler(cb: (text: string) => void): void {
  onUserBubble = cb;
}

/** Caller registers a handler that fires from inside reset() so any
 *  out-of-tree state mirroring the dictation buffer (e.g. main.ts's
 *  streaming user bubble id) can clear in lockstep. */
export function setOnResetHandler(cb: () => void): void {
  onReset = cb;
}

/** Caller registers a provider that returns the current utterance's
 *  pre-minted user_message_id. Called inside dispatchNow so the same
 *  id ships to the bridge → upstream → user_message echo. The
 *  provider is responsible for minting on first call within an
 *  utterance and returning the same value through finalize. */
export function setUserMessageIdProvider(fn: (() => string) | null): void {
  userMessageIdProvider = fn;
}

/** Clear all per-call dictation state. Call on call open AND close. */
export function reset(): void {
  buffer = [];
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  if (onReset) {
    try { onReset(); } catch { /* swallow — out-of-tree listener */ }
  }
}

async function dispatchNow(): Promise<void> {
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  const utterance = buffer.join(' ').trim();
  buffer = [];
  if (!utterance) return;
  // Cold-start splice: speech from before the bridge's STT pipe went
  // hot lives only in the parallel call recorder. takeHead is
  // single-consume (first dispatch of the call) and resolves '' on
  // any failure or after HEAD_WAIT_MS — every degraded path is just
  // an un-spliced dispatch. The splice happens BEFORE bubble +
  // dispatch so both carry identical text. The interim-streamed
  // bubble already exists during the wait, so the UI never stalls.
  let head = '';
  try { head = await callCapture.takeHead(HEAD_WAIT_MS); } catch { /* un-spliced */ }
  const text = head ? stitchTranscripts([head, utterance]) : utterance;
  if (head) {
    log('[dictation] cold-start splice:', `head="${head.slice(0, 80)}"`, `→ "${text.slice(0, 120)}"`);
  }
  log('[dictation] dispatch:', text.slice(0, 120));
  // Snag the userMessageId BEFORE invoking onUserBubble — the bubble
  // handler may consume + clear the provider's state when it
  // finalizes (next utterance mints fresh). Same id rides the wire
  // so the server's user_message echo collapses idempotently.
  const userMessageId = userMessageIdProvider ? userMessageIdProvider() : undefined;
  if (onUserBubble) {
    try { onUserBubble(text); } catch (e: any) { diag('[dictation] bubble handler err', e?.message); }
  }
  const ok = conn.dispatch(text, userMessageId);
  if (!ok) {
    diag('[dictation] dispatch send failed (channel not open?)');
    return;
  }
  // No 'send' chime here: in WebRTC voice mode the dispatch is a
  // synchronous data-channel write (no network round-trip from the
  // PWA's POV — the bridge is the one talking to the agent). Firing
  // 'send' here means commit and send chimes overlap by microseconds
  // and merge audibly into one merged tone. Instead, main.ts fires
  // 'send' on the first assistant delta arriving over the data
  // channel — i.e. when the AGENT has actually received the
  // utterance and started replying. Real time gap, real meaning:
  // commit = "I heard the over"; send = "agent is replying."
}

function armSilenceTimer(): void {
  if (silenceTimer !== null) {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }
  const { silenceSec } = getHandsfreeConfig();
  if (silenceSec <= 0) return;  // 0 = disabled (sendword-only mode).
  silenceTimer = setTimeout(() => {
    silenceTimer = null;
    void dispatchNow();
  }, silenceSec * 1000);
}

/**
 * Feed an is_final user transcript into the dictation state machine.
 *
 * Behavior:
 *   - If the joined buffer + this segment matches the commit phrase,
 *     strip it and dispatch immediately.
 *   - Otherwise append to buffer and arm the silence timer.
 *
 * Interim transcripts should NOT be passed here — they're for live
 * caption rendering and don't move the state machine.
 */
export function handleUserFinal(text: string): void {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  const joined = (buffer.join(' ') + ' ' + trimmed).trim();
  const { sendwordPhrase } = getHandsfreeConfig();
  const m = matchSendword(joined, sendwordPhrase);
  if (m.matched) {
    // Match: replace whatever's buffered with the cleaned prefix and
    // dispatch immediately. The 'commit' chime fires the moment the
    // send-word lands so the user gets feedback BEFORE the dispatch
    // round-trips — pairs with the 'send' chime in dispatchNow().
    try { playFeedback('commit'); } catch { /* feedback is best-effort */ }
    buffer = m.cleaned ? [m.cleaned] : [];
    void dispatchNow();
    return;
  }
  buffer.push(trimmed);
  armSilenceTimer();
}
