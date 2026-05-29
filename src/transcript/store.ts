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
    pagination: { firstId: null, hasMore: false, lastId: null, hasMoreNewer: false },
  };
}

/** Pagination as the items endpoint surfaces it. Callers may pass only
 *  the older-cursor half (`firstId`/`hasMore`) — the newer-cursor half
 *  defaults to "tail-anchored" (lastId null, hasMoreNewer false), which
 *  is correct for a normal resume / load-earlier where the loaded run
 *  already reaches the live tail. Only a deep `around` window passes the
 *  newer half explicitly. */
type PaginationInput = {
  firstId: number | null;
  hasMore: boolean;
  lastId?: number | null;
  hasMoreNewer?: boolean;
};

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

/** Replace durable rows wholesale (typical /messages response). Also
 *  drops inflight envelopes that belong to turns we've already seen
 *  reply_final for — durable is now authoritative for that turn, and
 *  the local envelopes were only useful for the streaming window.
 *
 *  Why: when the plugin's `_write_msg_links_after_turn` fails to link a
 *  state.db row to its SSE-shape sidekick_id, the projection sees two
 *  keys for the same message — durable's integer-id key and inflight's
 *  umsg_ / msg_ key — and can't dedup them. Result: an "orphan tail"
 *  of duplicate ghost turns at the bottom of the transcript with
 *  synthetic timestamps (Jonathan field bug 2026-05-18, chat
 *  54f0e929 — the entire RFC turn re-appeared at 17:24/17:25).
 *
 *  Dropping completed-turn envelopes here breaks the accumulation: the
 *  in-progress turn (no reply_final yet) is preserved for live render. */
export function setDurable(
  chatId: string,
  items: ConversationItem[],
  pagination: PaginationInput,
): void {
  const s = getState(chatId);
  s.durable = items.slice();
  s.pagination = {
    firstId: pagination.firstId,
    hasMore: pagination.hasMore,
    lastId: pagination.lastId ?? null,
    hasMoreNewer: pagination.hasMoreNewer ?? false,
  };
  s.inflight = dropCompletedTurnEnvelopes(s.inflight, s.durable);
  notify(chatId);
}

/** Walk an envelope array and drop completed-turn envelopes whose
 *  reply_final's message_id is present in durable as a `sidekick_id`.
 *  "Completed" = reply_final has fired; "present in durable" = the
 *  server-side mirror caught up and the projection can dedup off
 *  durable. When the mirror hasn't caught up (e.g. background-chat
 *  reply arrived via SSE but state.db/sidekick.db write-through
 *  hasn't landed yet), the inflight envelope is the ONLY copy of
 *  the content and we must NOT drop it (field bug 2026-05-19:
 *  background-reply-first-switch-shows-content.mjs).
 *
 *  Original motivation (commit 4d2f7dd): plugin's link-table write
 *  silently failed → durable had assistant rows with sidekick_id
 *  NULL → projection couldn't dedup integer-id durable keys against
 *  SSE-shape inflight keys → ghost-tail of the just-finished turn.
 *  With phase-3 self-heal landed in supplemental store, the NULL
 *  sidekick_id case is rare; when it still occurs the inflight
 *  envelope stays and the projection's own dedup (text match by
 *  key) handles it.
 */
function dropCompletedTurnEnvelopes(
  envs: SidekickEnvelope[],
  durable: ConversationItem[],
): SidekickEnvelope[] {
  if (envs.length === 0) return envs;
  const durableSidekickIds = new Set<string>();
  for (const d of durable) {
    if (d.sidekick_id) durableSidekickIds.add(d.sidekick_id);
  }
  // Walk from end; find the most recent reply_final whose message_id
  // IS present in durable. Only completed turns whose mirror has
  // landed are safe to drop. Everything earlier (and everything since)
  // stays — the inflight is still the source of truth for those.
  let lastSafeIdx = -1;
  for (let i = envs.length - 1; i >= 0; i--) {
    const e = envs[i];
    if (e.type !== 'reply_final') continue;
    const mid = (e as { message_id?: string }).message_id;
    if (mid && durableSidekickIds.has(mid)) {
      lastSafeIdx = i;
      break;
    }
  }
  if (lastSafeIdx < 0) return envs;
  return envs.slice(lastSafeIdx + 1);
}

/** Prepend older rows from a load-earlier fetch. Only the older-cursor
 *  half (`firstId`/`hasMore`) moves; the newer cursor (lastId/
 *  hasMoreNewer) is untouched — prepending head rows can't change where
 *  the tail of the loaded run sits. */
export function prependDurable(
  chatId: string,
  items: ConversationItem[],
  pagination: { firstId: number | null; hasMore: boolean },
): void {
  const s = getState(chatId);
  if (items.length) s.durable = items.concat(s.durable);
  s.pagination = { ...s.pagination, firstId: pagination.firstId, hasMore: pagination.hasMore };
  notify(chatId);
}

/** Append newer rows from a load-later fetch — the symmetric counterpart
 *  to prependDurable. Only the newer-cursor half (`lastId`/
 *  `hasMoreNewer`) moves; the older cursor is untouched. When
 *  `hasMoreNewer` becomes false the loaded run has reached the live tail,
 *  which is the signal the caller uses to (re)enable IDB persistence for
 *  the now-contiguous-to-tail transcript. */
export function appendDurable(
  chatId: string,
  items: ConversationItem[],
  pagination: { lastId: number | null; hasMoreNewer: boolean },
): void {
  const s = getState(chatId);
  if (items.length) s.durable = s.durable.concat(items);
  s.pagination = { ...s.pagination, lastId: pagination.lastId, hasMoreNewer: pagination.hasMoreNewer };
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

/** Drain inflight envelopes through one completed reply_final. This is
 *  stricter than clearInflight(): if the user starts another turn
 *  before the post-final durable refresh lands, envelopes after this
 *  reply_final survive. */
export function clearInflightThroughReplyFinal(chatId: string, messageId: string): void {
  if (!messageId) return;
  const s = getState(chatId);
  if (!s.inflight.length) return;
  const idx = s.inflight.findIndex((e) =>
    e.type === 'reply_final' && (e as { message_id?: string }).message_id === messageId,
  );
  if (idx < 0) return;
  s.inflight = s.inflight.slice(idx + 1);
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
