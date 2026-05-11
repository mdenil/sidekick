// In-memory ephemeral cache of SSE envelopes for in-flight turns.
//
// Why this exists: hermes-core persists messages POST-turn (see
// gateway/run.py:7311 — `session_store.append_to_transcript` fires
// after `agent_result` is computed). For a 30-second tool-using
// turn, the user's message + intermediate tool envelopes don't
// exist in state.db for that entire window. If the user switches
// chats mid-turn and switches back, the history-fetch returns
// nothing for the in-flight chat — the bubble vanishes from the
// UI even though everything is working server-side.
//
// This module bridges that gap: every envelope the proxy forwards
// during a turn is ALSO recorded here, keyed by chat_id. The
// history endpoint reads this and includes it as `inflight: [...]`
// alongside state.db's `messages: [...]`. The PWA replays both.
//
// Lifecycle:
//   - Append: every envelope from `dispatchTurnViaUpstream` is
//     recorded with an arrival timestamp.
//   - Drop-on-handoff: when `reply_final` fires, the proxy drops
//     ALL of that chat's inflight entries — state.db is now
//     canonical for the turn, and continuing to surface inflight
//     copies would dupe (state.db row + inflight envelope each
//     trigger a render path).
//   - TTL: every IDLE_PRUNE_MS, prune entries older than INFLIGHT_TTL_MS.
//     Catches turns that never complete (agent crashed mid-stream,
//     approval-pending forever, etc.) so the inflight Map doesn't
//     grow without bound.
//   - Process-restart: in-memory only. Bun restart loses inflight.
//     The SSE replay-ring at the upstream gateway covers a small
//     reconnect window. Anything older than that gap is genuinely
//     lost — but it would have been lost anyway since state.db
//     wasn't written either.
//
// Dedup discipline (carries forward from sidekick_msg_links work):
//   Every envelope carries a stable id (user_message_id /
//   message_id / call_id). The PWA's renderedMessages.upsert and
//   activityRow.upsert keys are idempotent on those ids. So when
//   a client subscribes via live SSE AND fetches history at the
//   same time, the same envelope arriving via both paths collapses
//   to one bubble. No deduping logic needed here in the cache —
//   it just records.

import type { SidekickEnvelope } from './upstream.ts';

/** TTL for inflight envelopes — entries older than this get pruned
 *  on the next sweep. 30 minutes gives a comfortable "send + walk
 *  away" window for the PWA: the user fires off a turn, switches
 *  chats (or backgrounds the app), and on return the in-flight
 *  indicator + envelopes are still here ready to replay (field bug
 *  2026-05-11, Jonathan multi-session juggling). Memory cost is
 *  negligible (a busy turn is dozens of ~1KB envelopes; abandoned
 *  turns past TTL get evicted on the next sweep). 10-min default was
 *  conservative-not-correct; the constraint is "long enough that the
 *  user doesn't lose the indicator after a coffee break", and 30 min
 *  comfortably exceeds that. */
const INFLIGHT_TTL_MS = 30 * 60 * 1000;

/** Sweep interval. 60s is fine even for the 30-min TTL — worst case
 *  an entry lives ~31 minutes before pruning, which is fine; we're
 *  bounded by MAX_PER_CHAT either way. */
const PRUNE_INTERVAL_MS = 60 * 1000;

/** Hard cap on envelopes per chat. A pathological turn that emits
 *  thousands of envelopes without `reply_final` would otherwise eat
 *  memory. 2000 covers any plausible real turn — the longest tool
 *  chains we've seen are dozens of envelopes. Drop oldest on
 *  overflow. */
const MAX_PER_CHAT = 2000;

interface InflightEntry {
  envelope: SidekickEnvelope;
  at: number;  // ms timestamp at append
}

const store = new Map<string, InflightEntry[]>();

/** Grace window between reply_final and the actual drop. State.db's
 *  post-turn append_to_transcript fires AFTER reply_final reaches the
 *  proxy; if a client switches in/out during that gap, an immediate
 *  drop leaves the user with neither inflight nor state.db data —
 *  bubbles vanish (field bug 2026-05-11, Jonathan's notion-planner
 *  chat). 30s comfortably covers the typical post-turn persist
 *  latency we've seen (sub-second to ~2s) with margin for slow disks
 *  / heavy gateway load.
 *
 *  Trade-off: during the grace window, a fresh history-fetch returns
 *  BOTH state.db rows (now present) AND inflight envelopes. The PWA
 *  dedups them via stable id when sidekick_msg_links has recorded
 *  the umsg_X / msg_X to integer_id pairing. When the link table
 *  misses (e.g. interrupted turns that don't fire post-turn
 *  link-write), both copies render - preferable to neither. */
const DROP_GRACE_MS = 30_000;

/** Per-chat pending drop handles. dropChat() schedules; subsequent
 *  record() calls cancel (chat is active again); the actual delete
 *  runs DROP_GRACE_MS after the LAST dropChat() call. */
const pendingDrops = new Map<string, ReturnType<typeof setTimeout>>();

function cancelPendingDrop(chatId: string): void {
  const t = pendingDrops.get(chatId);
  if (t !== undefined) {
    clearTimeout(t);
    pendingDrops.delete(chatId);
  }
}

/** Append an envelope to a chat's inflight queue. Idempotency is
 *  the caller's concern — we record every call. Dedup happens at
 *  render time via the envelope's stable id. */
export function record(chatId: string, envelope: SidekickEnvelope): void {
  if (!chatId) return;
  // If a drop is pending (the chat was about to be cleared after a
  // recent reply_final), a new envelope means the turn is still
  // active — cancel the drop. Common case: the agent emits a
  // reply_final for one bubble, then another reply_delta for a
  // follow-up bubble. Without this the cache would wipe between.
  cancelPendingDrop(chatId);
  let arr = store.get(chatId);
  if (!arr) {
    arr = [];
    store.set(chatId, arr);
  }
  arr.push({ envelope, at: Date.now() });
  if (arr.length > MAX_PER_CHAT) {
    // Drop oldest to keep memory bounded. The truncated entries are
    // probably already represented in state.db anyway (this only
    // happens on pathologically long turns where reply_final hasn't
    // fired but lots of work has streamed).
    arr.splice(0, arr.length - MAX_PER_CHAT);
  }
}

/** Schedule a chat's inflight entries for deletion after DROP_GRACE_MS.
 *  Called on `reply_final` — state.db's persist is in flight but hasn't
 *  necessarily completed; the grace period lets it catch up before we
 *  invalidate the inflight bridge. If another envelope arrives during
 *  the grace window, the pending drop is cancelled (chat is active). */
export function dropChat(chatId: string): void {
  if (!chatId) return;
  // Reset the timer — most recent reply_final wins. Without the reset,
  // a rapid succession of reply_finals (multi-bubble turns) would have
  // their grace windows overlap awkwardly.
  cancelPendingDrop(chatId);
  const t = setTimeout(() => {
    store.delete(chatId);
    pendingDrops.delete(chatId);
  }, DROP_GRACE_MS);
  if (typeof t.unref === 'function') t.unref();
  pendingDrops.set(chatId, t);
}

/** Return envelopes for a chat in arrival order (oldest first).
 *  Empty array if no inflight for this chat. Caller may filter
 *  further (e.g. drop transient `typing` envelopes from history-
 *  replay context). */
export function getForChat(chatId: string): SidekickEnvelope[] {
  const arr = store.get(chatId);
  if (!arr || arr.length === 0) return [];
  return arr.map(e => e.envelope);
}

/** Walk all chats; drop entries older than INFLIGHT_TTL_MS. If a
 *  chat ends up empty, remove the Map entry. Intended to run on
 *  PRUNE_INTERVAL_MS. */
export function pruneExpired(now: number = Date.now()): void {
  const cutoff = now - INFLIGHT_TTL_MS;
  for (const [chatId, arr] of store) {
    const kept = arr.filter(e => e.at >= cutoff);
    if (kept.length === 0) {
      store.delete(chatId);
    } else if (kept.length !== arr.length) {
      store.set(chatId, kept);
    }
  }
}

let pruneTimer: ReturnType<typeof setInterval> | null = null;

/** Start the periodic prune sweep. Idempotent — calling twice does
 *  nothing extra. Server.ts calls this once at boot. */
export function startPruneSweep(): void {
  if (pruneTimer !== null) return;
  pruneTimer = setInterval(() => pruneExpired(), PRUNE_INTERVAL_MS);
  // Unref so the timer doesn't hold the event loop open on shutdown.
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
}

/** Test-only helpers. */
export const _test = {
  reset(): void {
    for (const t of pendingDrops.values()) clearTimeout(t);
    pendingDrops.clear();
    store.clear();
  },
  /** Force the pending dropChat for `chatId` to run immediately
   *  (cancels the grace timer, runs the delete). Used by tests that
   *  want to assert the post-drop state without waiting DROP_GRACE_MS. */
  forceDrop(chatId: string): void {
    const t = pendingDrops.get(chatId);
    if (t !== undefined) {
      clearTimeout(t);
      pendingDrops.delete(chatId);
    }
    store.delete(chatId);
  },
  size(): number {
    let n = 0;
    for (const arr of store.values()) n += arr.length;
    return n;
  },
  chatSize(chatId: string): number {
    return store.get(chatId)?.length ?? 0;
  },
};

export const INFLIGHT_TTL_MS_EXPORT = INFLIGHT_TTL_MS;
