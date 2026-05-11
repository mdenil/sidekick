// Streaming indicator — the in-flight reply bubble state machine.
// Extracted from main.ts 2026-05-11 for the Phase 2 / pre-notifications
// refactor (see docs/NOTIFICATIONS_REFACTOR_PLAN.md).
//
// One bubble at a time: there's at most one ".line.streaming" in the
// transcript. The bubble walks through three states:
//
//   1. Pending — created by `showThinking()` the instant the user
//      sends a message, BEFORE any backend event arrives. Synthetic
//      replyId; .pending class on the bubble; "sending…" dots.
//      Without this, the agent's tool-call-first turns leave a blank
//      screen and the user wonders if anything happened.
//
//   2. Streaming — promoted by `showStreamingIndicator(text, replyId,
//      messageId?)` on the first onDelta. Adopts the real replyId,
//      drops .pending, populates text, migrates the renderedMessages
//      key to the message_id when known. The 90s idle timer resets
//      on every delta so a still-thinking agent never gets cleared.
//
//   3. Finalized — `finalizeStreamingBubble(text, messageId?)` strips
//      .streaming, removes the thinking dots, opens links in new
//      tabs. The bubble stays in the DOM as a regular agent reply.
//      `clearStreamingIndicator()` is the escape hatch when the
//      stream errored / timed out — removes the bubble entirely.
//
// Separately, this module also owns the per-chat "pending user
// bubble" list (`pendingBubblesByChat`). When the user sends, the
// optimistic user-bubble is registered via `trackPendingBubble`;
// when the agent's typing/working envelope arrives,
// `finalizeOldestPending(chatId)` flips the oldest tracked bubble
// from .pending to finalized. Kept here rather than in send-flow
// because finalizeOldestPending is called from the activity handler
// alongside the streaming bubble's "sending…" → "thinking…"
// transition.
//
// What's NOT here: the adapter event handlers themselves
// (handleReplyDelta / handleReplyFinal / handleActivity). Those
// stay in main.ts (or move to backendEvents.ts in a follow-up)
// and import from this module. Splitting purely-state from
// dispatch keeps each file's responsibility singular.

import { miniMarkdown } from './util/markdown.ts';
import * as chat from './chat.ts';
import * as renderedMessages from './renderedMessages.ts';

/** Max time the bubble lingers on screen with no new events before we
 *  assume the reply is stuck. 90s is generous — tool calls (calendar
 *  scans, web fetches) can run long before any text arrives. */
const STREAMING_IDLE_TIMEOUT_MS = 90_000;

let streamingIdleTimer: ReturnType<typeof setTimeout> | null = null;

/** Synthetic key under which a pending-thinking bubble is registered
 *  in the renderedMessages map before any real message_id is known.
 *  Migrated to the real id on the first reply_delta carrying one.
 *  The in-flight bubble element itself is recovered via
 *  renderedMessages.getStreaming() — no module-level DOM ref needed. */
let pendingStreamingKey: string | null = null;

/** Q1 atomic-bubble: outstanding pending user bubbles per chat_id,
 *  in send order. Drained oldest-first when an agent envelope (typing
 *  / reply_delta) arrives for that chat — that envelope is the proof
 *  the agent received our message. */
const pendingBubblesByChat = new Map<string, HTMLElement[]>();

let getAgentLabelRef: () => string = () => 'Agent';

/** Wire the module's external dependencies. Currently just the
 *  agent-label callback — different deployments use "Clawdian",
 *  "Sidekick", or a custom value from config. Called once at boot. */
export function initStreamingIndicator(opts: { getAgentLabel: () => string }): void {
  getAgentLabelRef = opts.getAgentLabel;
}

/** Create a tentative "the agent is working on it" bubble. Fired the
 *  instant the user sends a message, BEFORE any backend events
 *  arrive. Prevents the silent-chat problem where the agent jumps
 *  straight to tool calls without streaming text first — user would
 *  otherwise stare at a blank screen and wonder if anything happened.
 *
 *  On the first onDelta, `showStreamingIndicator` transitions this
 *  bubble into the real streaming reply (adopts a fresh replyId,
 *  populates text, wires the play-bar + TTS event stream). On
 *  onFinal with empty text or a 90s no-event timeout,
 *  `clearStreamingIndicator` removes it. */
export function showThinking(): void {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;
  if (renderedMessages.getStreaming()) return;  // already showing; don't stack
  // Sweep any orphan streaming bubbles that escaped the map (e.g. an
  // interrupt aborted a stream mid-flight without going through
  // finalize). Invariant: at most one streaming bubble visible.
  transcriptEl.querySelectorAll('.line.streaming').forEach(el => el.remove());
  // Use a temporary replyId so the bubble has a data-reply-id from the
  // start (needed for TTS / DOM lookup); will be swapped out by the
  // adapter's real id on first delta.
  const tempId = `r-pending-${Date.now()}`;
  pendingStreamingKey = `pending:${tempId}`;
  const el = renderedMessages.upsert(pendingStreamingKey, {
    role: 'assistant',
    text: '',
    status: 'streaming',
    speaker: getAgentLabelRef(),
    cls: 'agent streaming pending',
    markdown: true,
    replyId: tempId,
  });
  if (el) {
    const dots = document.createElement('span');
    dots.className = 'thinking-dots';
    dots.textContent = 'sending…';
    el.appendChild(dots);
  }
  chat.autoScroll();
  if (streamingIdleTimer) clearTimeout(streamingIdleTimer);
  streamingIdleTimer = setTimeout(clearStreamingIndicator, STREAMING_IDLE_TIMEOUT_MS);
}

/** Show or update the in-flight agent bubble. Called on onDelta
 *  events. If showThinking() already created a tentative bubble,
 *  this upgrades it in place — migrates the map key to the real
 *  message_id, adopts the real replyId + populates text. Otherwise
 *  creates a fresh bubble (e.g. agent-initiated messages where
 *  there was no user send to trigger the thinking bubble). */
export function showStreamingIndicator(
  partialText: string,
  replyId: string,
  messageId?: string | null,
): void {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;

  let el = renderedMessages.getStreaming();
  // Resolve the renderedMessages key. Prefer the real message_id;
  // fall back to the pending key if showThinking already minted one
  // and the adapter hasn't surfaced a message_id yet.
  const key = messageId || pendingStreamingKey || `live:${replyId}`;

  if (!el) {
    // Sweep any stragglers before creating a new bubble — one
    // streaming indicator at a time, no exceptions.
    transcriptEl.querySelectorAll('.line.streaming').forEach(elt => elt.remove());
    el = renderedMessages.upsert(key, {
      role: 'assistant',
      text: partialText || '',
      status: 'streaming',
      speaker: getAgentLabelRef(),
      cls: 'agent streaming',
      markdown: true,
      replyId,
    });
    if (el) {
      const dots = document.createElement('span');
      dots.className = 'thinking-dots';
      dots.textContent = 'thinking…';
      if (partialText) dots.classList.add('hidden');
      el.appendChild(dots);
    }
  } else {
    // Pending-thinking bubble exists — promote it: migrate the map
    // key to the real message_id, adopt the real reply id, populate
    // text.
    if (pendingStreamingKey && messageId && pendingStreamingKey !== messageId) {
      renderedMessages.migrate(pendingStreamingKey, messageId);
      pendingStreamingKey = null;
    }
    el.classList.remove('pending');
    if (partialText) {
      renderedMessages.upsert(key, {
        role: 'assistant',
        text: partialText,
        status: 'streaming',
        speaker: getAgentLabelRef(),
        cls: 'agent streaming',
        markdown: true,
        replyId,
      });
      const dots = el.querySelector('.thinking-dots');
      if (dots) dots.classList.add('hidden');
    } else {
      // No text yet — still update replyId/messageId on the existing
      // bubble so downstream lookups work.
      el.dataset.replyId = replyId;
      if (messageId) el.dataset.messageId = messageId;
    }
  }
  chat.autoScroll();

  // Safety net: if a reply gets stuck with no more events, auto-clear.
  if (streamingIdleTimer) clearTimeout(streamingIdleTimer);
  streamingIdleTimer = setTimeout(clearStreamingIndicator, STREAMING_IDLE_TIMEOUT_MS);
}

/** Promote the streaming bubble to its final form: update text,
 *  remove thinking dots, strip the .streaming class, open links in
 *  new tabs. Returns the bubble element (already in the DOM) or
 *  null if no streaming bubble existed. */
export function finalizeStreamingBubble(
  finalText: string,
  messageId?: string | null,
): HTMLElement | null {
  if (streamingIdleTimer) { clearTimeout(streamingIdleTimer); streamingIdleTimer = null; }
  const el = renderedMessages.getStreaming();
  if (!el) return null;
  // Resolve the map key for this bubble. messageId wins if known;
  // else fall back to whatever synthetic key the streaming bubble
  // was registered under.
  const key = messageId
    || el.dataset.messageId
    || pendingStreamingKey
    || (el.dataset.replyId ? `live:${el.dataset.replyId}` : null);
  if (key) {
    if (pendingStreamingKey && messageId && pendingStreamingKey !== messageId) {
      renderedMessages.migrate(pendingStreamingKey, messageId);
    }
    renderedMessages.upsert(key, {
      role: 'assistant',
      text: finalText,
      status: 'finalized',
      speaker: getAgentLabelRef(),
      cls: 'agent',
      markdown: true,
      replyId: el.dataset.replyId,
    });
  } else {
    // Defensive fallback: bubble somehow not in the map. Mirror the
    // original in-place finalize so behavior matches pre-refactor.
    const textSpan = el.querySelector('.text');
    if (textSpan) textSpan.innerHTML = miniMarkdown(finalText);
    el.dataset.text = finalText;
    const dots = el.querySelector('.thinking-dots');
    if (dots) dots.remove();
    el.classList.remove('streaming');
    el.querySelectorAll('a').forEach(a => { a.target = '_blank'; (a as HTMLAnchorElement).rel = 'noopener'; });
  }
  pendingStreamingKey = null;
  return el;
}

/** Tear down the streaming bubble without finalizing — used by the
 *  90s idle timeout and the abort path. Removes the DOM node;
 *  callers don't need to follow up. */
export function clearStreamingIndicator(): void {
  if (streamingIdleTimer) { clearTimeout(streamingIdleTimer); streamingIdleTimer = null; }
  const el = renderedMessages.getStreaming();
  if (!el) return;
  if (pendingStreamingKey) {
    renderedMessages.remove(pendingStreamingKey);
    pendingStreamingKey = null;
  } else {
    el.remove();
  }
}

/** Reset the idle timer to its full 90s. Called by the activity
 *  handler on every typing/working envelope so an actively-thinking
 *  agent (e.g. mid-tool-call) never falls into the stuck-stream
 *  clear. Kept exported because the activity handler still lives in
 *  main.ts; will collapse into the module when handleActivity moves
 *  to backendEvents.ts. */
export function resetStreamingIdleTimer(): void {
  if (streamingIdleTimer) clearTimeout(streamingIdleTimer);
  streamingIdleTimer = setTimeout(clearStreamingIndicator, STREAMING_IDLE_TIMEOUT_MS);
}

/** Register a freshly-created optimistic user bubble for a chat.
 *  Called from sendTypedMessage AFTER the user-bubble upsert. The
 *  bubble starts with class `.pending`; finalizeOldestPending flips
 *  it once the agent's first typing/working envelope arrives.
 *  Order-preserving — Map.set semantics retain insertion order for
 *  same-chat repeats. */
export function trackPendingBubble(chatId: string, bubble: HTMLElement): void {
  const list = pendingBubblesByChat.get(chatId) || [];
  list.push(bubble);
  pendingBubblesByChat.set(chatId, list);
}

/** Drop a tracked pending bubble before it's finalized — used by
 *  the failBubble path when /messages POST throws. Same chat,
 *  removes by element identity. No-op if the bubble isn't tracked
 *  (e.g. the bubble was already finalized via finalizeOldestPending
 *  during a race). */
export function untrackPendingBubble(chatId: string, bubble: HTMLElement): void {
  const list = pendingBubblesByChat.get(chatId);
  if (!list) return;
  const idx = list.indexOf(bubble);
  if (idx >= 0) list.splice(idx, 1);
  if (list.length === 0) pendingBubblesByChat.delete(chatId);
}

/** Finalize the oldest pending user bubble for a chat. Called by
 *  the activity handler when the agent's first
 *  typing/working/reply_delta envelope arrives for that chat — the
 *  envelope is proof the agent received the message, so the bubble
 *  is no longer "in flight." */
export function finalizeOldestPending(conversation: string | null | undefined): void {
  if (!conversation) return;
  const list = pendingBubblesByChat.get(conversation);
  if (!list || list.length === 0) return;
  const bubble = list.shift()!;
  if (list.length === 0) pendingBubblesByChat.delete(conversation);
  chat.markBubbleFinalized(bubble);
}
