/**
 * @fileoverview Crack A — per-chat ChatState store. The single source of
 * truth that the projection consumes.
 *
 * Wiring:
 *   - `/v1/conversations/{id}/items` responses call `setDurable` +
 *     `setInflight` for the active chat.
 *   - SSE handlers call `appendInflight` as each envelope arrives.
 *   - Optimistic send path calls `addPendingSend` before posting;
 *     `markPendingSendFailed` on POST error; `clearPendingSend` on
 *     reply_final acknowledgement.
 *
 * Subscribers are notified per-chat. The reconciler subscribes and
 * re-projects + re-renders only when the *active* chat changes — events
 * for background chats mutate state silently so a future switch-back
 * sees the up-to-date model.
 */

import type {
  ChatState,
  ConversationItem,
  PendingSend,
  SidekickEnvelope,
} from './types.ts';

const states = new Map<string, ChatState>();
const subscribers = new Set<(chatId: string) => void>();

function emptyChatState(): ChatState {
  return {
    durable: [],
    inflight: [],
    pendingSends: [],
    pagination: { firstId: null, hasMore: false },
  };
}

/** Get (and lazily create) the ChatState for `chatId`. Returns a live
 *  reference — callers should NOT mutate it directly; go through the
 *  exported mutators so subscribers fire. */
export function getState(chatId: string): ChatState {
  let s = states.get(chatId);
  if (!s) {
    s = emptyChatState();
    states.set(chatId, s);
  }
  return s;
}

/** Replace durable rows wholesale (typical /messages response). */
export function setDurable(
  chatId: string,
  items: ConversationItem[],
  pagination: { firstId: number | null; hasMore: boolean },
): void {
  const s = getState(chatId);
  s.durable = items.slice();
  s.pagination = { ...pagination };
  notify(chatId);
}

/** Prepend older rows from a load-earlier fetch. `pagination` reflects
 *  the new earliest cursor. */
export function prependDurable(
  chatId: string,
  items: ConversationItem[],
  pagination: { firstId: number | null; hasMore: boolean },
): void {
  if (!items.length) {
    const s = getState(chatId);
    s.pagination = { ...pagination };
    notify(chatId);
    return;
  }
  const s = getState(chatId);
  s.durable = items.concat(s.durable);
  s.pagination = { ...pagination };
  notify(chatId);
}

/** Merge inflight envelopes from a /messages response. The local store
 *  may already hold envelopes that arrived via live SSE while the chat
 *  was off-screen; those are AUTHORITATIVE (server is just snapshotting
 *  what it knows). Behavior:
 *
 *  - Input non-empty: replace store.inflight with the input. The server
 *    response is the cold-reconnect snapshot — it tells us what to show
 *    fresh.
 *  - Input empty: KEEP existing store.inflight. The proxy omits the
 *    field when it has nothing to send, but our local stream may have
 *    captured envelopes the server already drained from TurnBuffer.
 *    Trying to overwrite with `[]` here was the Bug A regression
 *    (switch-back wiped the in-flight turn we'd accumulated locally).
 *
 *  Callers that want unconditional drain use clearInflight(). */
export function setInflight(chatId: string, envelopes: SidekickEnvelope[]): void {
  const s = getState(chatId);
  if (!envelopes.length) {
    // Nothing to merge in; preserve what live SSE captured.
    return;
  }
  s.inflight = envelopes.slice();
  notify(chatId);
}

/** Append a single envelope (live SSE). The projection orders by
 *  array index; envelopes for unfrozen turns should arrive in
 *  user_message → tool_call/result → reply_delta → reply_final order. */
export function appendInflight(chatId: string, env: SidekickEnvelope): void {
  const s = getState(chatId);
  s.inflight.push(env);
  notify(chatId);
}

/** Drain inflight envelopes — typically called after reply_final once
 *  the next /messages fetch lands and absorbs the turn into durable. */
export function clearInflight(chatId: string): void {
  const s = getState(chatId);
  if (!s.inflight.length) return;
  s.inflight = [];
  notify(chatId);
}

/** Add an optimistic user send. Dedup'd by messageId. */
export function addPendingSend(chatId: string, send: PendingSend): void {
  const s = getState(chatId);
  if (s.pendingSends.find(p => p.messageId === send.messageId)) return;
  s.pendingSends.push(send);
  notify(chatId);
}

/** Update the text of an in-flight pending send. Used by the live
 *  dictation streaming bubble — as the WebRTC bridge emits new
 *  interim transcripts, the bubble's text grows. */
export function updatePendingSend(chatId: string, messageId: string, text: string): void {
  const s = getState(chatId);
  const p = s.pendingSends.find(p => p.messageId === messageId);
  if (!p) return;
  if (p.text === text) return;
  p.text = text;
  notify(chatId);
}

export function markPendingSendFailed(chatId: string, messageId: string): void {
  const s = getState(chatId);
  const p = s.pendingSends.find(p => p.messageId === messageId);
  if (!p) return;
  p.failed = true;
  notify(chatId);
}

export function clearPendingSend(chatId: string, messageId: string): void {
  const s = getState(chatId);
  const i = s.pendingSends.findIndex(p => p.messageId === messageId);
  if (i < 0) return;
  s.pendingSends.splice(i, 1);
  notify(chatId);
}

/** Drop all state for a chat. Used on session deletion. */
export function clearAll(chatId: string): void {
  states.delete(chatId);
  notify(chatId);
}

/** Subscribe to per-chat state changes. The callback fires AFTER every
 *  mutator; the reconciler decides whether the change is for the
 *  currently-viewed chat and re-renders. Returns an unsubscribe fn. */
export function subscribe(fn: (chatId: string) => void): () => void {
  subscribers.add(fn);
  return () => { subscribers.delete(fn); };
}

function notify(chatId: string): void {
  for (const fn of subscribers) {
    try { fn(chatId); } catch (e) { console.error('[transcript-store] subscriber threw:', e); }
  }
}
