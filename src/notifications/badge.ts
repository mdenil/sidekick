// App-icon badge + per-chat unread state, server-driven.
//
// SSOT for sidebar badges + app badge + push dispatch is the backend
// plugin's `unread_state` table (see project_hermes_sidekick_parity.md).
// This module is a read-through cache + thin client over those routes:
//   GET  /api/sidekick/notifications/unread     → snapshot
//   POST /api/sidekick/notifications/seen       ← {chat_id}
//   POST /api/sidekick/notifications/mark       ← {chat_id, marked}
//
// Cross-device sync rides the `unread_changed` envelope that
// backendEvents observes on /api/sidekick/stream — when it arrives,
// the listener calls `requestRefresh()` to pull the new state.
//
// Why server-driven: the old IDB-side counter drifted when push
// arrivals + chat focus + the SW's setAppBadge fired on different
// code paths (Jonathan field bug: "app badge 7, click all chats,
// badge still 3"). With one fact-of-record on the server, the three
// surfaces (sidebar, app badge, push eligibility) derive structurally
// and can't disagree.

import { log } from '../util/log.ts';
import * as activityStore from './activityStore.ts';

// Read-through cache. The Map values are the per-chat unread counts
// the server returned at the last refresh. NEVER mutate these
// locally on push arrival — server has the truth, we just re-fetch.
const unreadByChat = new Map<string, number>();
const markedUnread = new Set<string>();
let refreshDebounce: number | null = null;
let hydrated = false;

/** Sum of unread counts across every chat. The number that lands on
 *  the app-icon badge. */
function totalUnread(): number {
  let total = 0;
  const seen = new Set<string>();
  for (const [id, n] of unreadByChat) {
    total += Math.max(n, markedUnread.has(id) ? 1 : 0);
    seen.add(id);
  }
  for (const id of markedUnread) {
    if (!seen.has(id)) total += 1;
  }
  return total;
}

/** Push the current unread total to the OS via Badging API. */
async function syncBadge(): Promise<void> {
  const total = totalUnread();
  try {
    if (total > 0) {
      if (typeof navigator.setAppBadge === 'function') await navigator.setAppBadge(total);
    } else {
      if (typeof navigator.clearAppBadge === 'function') await navigator.clearAppBadge();
      await closeAllSwNotifications();
    }
  } catch { /* unsupported / not installed */ }
}

async function closeAllSwNotifications(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const ns = await reg.getNotifications();
    for (const n of ns) { try { n.close(); } catch { /* tab vanished */ } }
    if (ns.length > 0) log(`[badge] closed ${ns.length} SW notification(s)`);
  } catch { /* defensive */ }
}

/** Fetch the canonical state from the plugin's `/v1/unread` via the
 *  proxy and update the cache + badge. Idempotent. Failure swallowed
 *  (badges are decorative).
 *
 *  syncBadge() ALWAYS runs (cheap OS API call) — it reconciles the
 *  app icon badge against the server's truth. Without this, a stale
 *  OS badge from a SW push (set while the PWA was closed) survives
 *  the next foreground refresh: Jonathan field bug 2026-05-16 —
 *  "PWA icon shows 7, sidebar empty after I marked all read on
 *  desktop." The fetched empty list matched the live empty cache, the
 *  diff returned no-change, and the previously-stuck OS badge from
 *  the SW push never got cleared.
 *
 *  notifyChange() (which triggers a sidebar repaint over ~86 rows)
 *  remains diff-gated to avoid the repaint storm Jonathan saw on Mac
 *  earlier the same day (WindowServer @ 122%). */
async function refreshFromServer(): Promise<void> {
  try {
    const r = await fetch('/api/sidekick/notifications/unread');
    if (!r.ok) return;
    const data: any = await r.json();
    const nextCounts = new Map<string, number>();
    const nextMarked = new Set<string>();
    for (const c of (data?.chats ?? [])) {
      if (typeof c?.chat_id !== 'string') continue;
      if (typeof c.unread_count === 'number' && c.unread_count > 0) {
        nextCounts.set(c.chat_id, c.unread_count);
      }
      if (c.marked_unread === true) nextMarked.add(c.chat_id);
    }
    const changed = !mapsEqual(unreadByChat, nextCounts) || !setsEqual(markedUnread, nextMarked);
    if (changed) {
      unreadByChat.clear();
      for (const [k, v] of nextCounts) unreadByChat.set(k, v);
      markedUnread.clear();
      for (const k of nextMarked) markedUnread.add(k);
    }
    await syncBadge();
    if (totalUnread() === 0 && activityStore.unreadActivityCount() > 0) activityStore.markAllRead();
    if (changed) notifyChange();
  } catch { /* swallow — best-effort */ }
}

function mapsEqual(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
}

/** Debounced refresh. 1.5s window — long enough that a burst of
 *  envelopes (cron-triggered notifications, multi-chat /seen
 *  cascades) coalesces into one fetch. Was 200ms; bumped after the
 *  Mac WindowServer load spike incident Jonathan caught. */
function requestRefresh(): void {
  if (refreshDebounce != null) return;
  refreshDebounce = (globalThis as any).setTimeout(() => {
    refreshDebounce = null;
    void refreshFromServer();
  }, 1500);
}

export function unreadFor(chatId: string): number {
  return unreadByChat.get(chatId) ?? 0;
}

export function isMarkedUnread(chatId: string): boolean {
  return markedUnread.has(chatId);
}

/** No-op locally. Kept as a stable hook for callers in
 *  backendEvents (off-screen reply_final, push arrival) — they call
 *  this to signal "something changed for this chat"; we trigger a
 *  server refresh and let the canonical count flow back. */
export function incrementUnread(_chatId: string, _delta: number = 1): void {
  requestRefresh();
}

/** User opened the chat — mark it seen on the server. The server
 *  broadcasts unread_changed, which triggers a fresh fetch via
 *  the SSE listener; we also kick a local refresh so the same
 *  device sees the update without waiting for the round-trip. */
export async function clearUnread(chatId: string): Promise<void> {
  if (!chatId) return;
  try {
    await fetch('/api/sidekick/notifications/seen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    });
  } catch { /* swallow */ }
  void refreshFromServer();
}

export async function markUnread(chatId: string): Promise<void> {
  if (!chatId || markedUnread.has(chatId)) return;
  try {
    await fetch('/api/sidekick/notifications/mark', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, marked: true }),
    });
  } catch { /* swallow */ }
  void refreshFromServer();
  log(`[badge] markUnread chat=${chatId}`);
}

export async function unmarkUnread(chatId: string): Promise<void> {
  if (!chatId) return;
  try {
    await fetch('/api/sidekick/notifications/mark', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, marked: false }),
    });
  } catch { /* swallow */ }
  void refreshFromServer();
  log(`[badge] unmarkUnread chat=${chatId}`);
}

/** Settings → "Mark all read" — clear seen for every known chat.
 *  No batch endpoint yet; fan out one POST per chat. With Jonathan's
 *  chat volume (low hundreds) the round-trip cost is fine; promote
 *  to a single POST /v1/unread/seen-all if it becomes hot. */
export async function clearAllUnread(): Promise<void> {
  const seenList = Array.from(unreadByChat.keys());
  const markedList = Array.from(markedUnread);
  const all = new Set([...seenList, ...markedList]);
  await Promise.all(Array.from(all).map((chatId) =>
    fetch('/api/sidekick/notifications/seen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId }),
    }).catch(() => {}),
  ));
  await refreshFromServer();
}

/** Boot-time hydrate. Stable name kept for existing call sites; the
 *  body now refreshes from the server instead of loading IDB
 *  (server holds the marked-unread set too). Idempotent.  */
export async function hydrateMarkedUnread(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  await refreshFromServer();
}

export function totalUnreadCount(): number { return totalUnread(); }

// ── Listeners ─────────────────────────────────────────────────────────

function notifyChange() {
  try {
    window.dispatchEvent(new CustomEvent('sidekick:unread-changed'));
  } catch { /* SSR / non-window environments */ }
}

// Server-pushed change notifications fan in here. backendEvents emits
// `sidekick:server-unread-changed` when it sees an `unread_changed`
// envelope on /api/sidekick/stream — re-fetch immediately.
if (typeof window !== 'undefined') {
  window.addEventListener('sidekick:server-unread-changed', () => requestRefresh());
  // Page visibility heartbeat → refresh on foreground. iOS PWA in
  // particular can come back after long backgrounding; pull fresh.
  document?.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestRefresh();
  });
}
