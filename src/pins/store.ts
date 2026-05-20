// Pinned-messages store — server-driven, cross-device coherent.
//
// SSOT for pins lives in the backend plugin's `pins` table (see
// project_hermes_sidekick_parity.md). This module is a read-through
// cache + thin client over those routes:
//   GET    /api/sidekick/pins              → snapshot
//   POST   /api/sidekick/pins              ← {chat_id, msg_id, role, text, timestamp}
//   DELETE /api/sidekick/pins/{chat}/{msg}
//
// Cross-device sync rides the `pins_changed` envelope that proxyClient
// observes on /api/sidekick/stream — when it arrives, the listener
// calls `requestRefresh()` to pull the new state.
//
// Why server-driven (mirror of badge.ts's history): IDB-side pins
// were strictly per-device. A user pinning a message on desktop and
// expecting to see it on their phone was a 2026-05-16 field bug —
// "afaict they are still fully decoupled. i cleared and created pins
// on desktop and mobile and they remained independent the whole time"
// (Jonathan). Server SSOT fixes this structurally.
//
// In-memory cache (`pinsByKey`) is a SYNC mirror of the server-returned
// state so chat.ts's `isPinned()` check on every bubble render doesn't
// have to await a fetch. Mutated only via server-driven refresh.

import { log } from '../util/log.ts';

export interface PinnedItem {
  chatId: string;
  msgId: string;
  role: string;       // 'user' / 'assistant' / 'system' — drives the row glyph in the drawer
  text: string;       // body preview, truncated upstream if needed
  timestamp: number;  // message wall-clock time (for display in the drawer)
  pinnedAt: number;   // when the user pinned it (for sort order)
}

// Read-through cache. Mutated only by refreshFromServer; NEVER write
// directly from user action paths — go through the server.
const pinsByKey = new Map<string, PinnedItem>();
let refreshDebounce: number | null = null;
let hydrated = false;

const key = (chatId: string, msgId: string) => `${chatId}|${msgId}`;

function notifyPinError(message: string): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('sidekick:pin-error', { detail: { message } }));
    }
  } catch { /* non-DOM hosts (test runner) */ }
}

/** Fetch the canonical pin set from the server and update the cache.
 *  Diff-aware: only fires `notifyChange()` (which triggers the
 *  pin-drawer repaint + per-bubble `.pinned` reflow) when the cache
 *  actually changed. Same mitigation pattern as badge.ts's
 *  refreshFromServer (Mac WindowServer repaint-storm guard). */
async function refreshFromServer(): Promise<void> {
  try {
    const r = await fetch('/api/sidekick/pins');
    if (!r.ok) return;
    const data: any = await r.json();
    const next = new Map<string, PinnedItem>();
    for (const p of (data?.pins ?? [])) {
      if (typeof p?.chatId !== 'string' || typeof p?.msgId !== 'string') continue;
      next.set(key(p.chatId, p.msgId), {
        chatId: p.chatId,
        msgId: p.msgId,
        role: typeof p.role === 'string' ? p.role : 'user',
        text: typeof p.text === 'string' ? p.text : '',
        timestamp: typeof p.timestamp === 'number' ? p.timestamp : Date.now(),
        pinnedAt: typeof p.pinnedAt === 'number' ? p.pinnedAt : Date.now(),
      });
    }
    if (!mapsEqual(pinsByKey, next)) {
      pinsByKey.clear();
      for (const [k, v] of next) pinsByKey.set(k, v);
      notifyChange();
    }
  } catch { /* swallow — pins are best-effort */ }
}

function mapsEqual(a: Map<string, PinnedItem>, b: Map<string, PinnedItem>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) {
    const o = b.get(k);
    if (!o || o.pinnedAt !== v.pinnedAt || o.text !== v.text) return false;
  }
  return true;
}

/** Debounced refresh — coalesces bursts of server-pins-changed
 *  envelopes into one fetch. 800ms is shorter than badge's 1500ms
 *  because pin mutations are typically user-initiated singletons,
 *  not cron-triggered cascades. */
function requestRefresh(): void {
  if (refreshDebounce != null) return;
  refreshDebounce = (globalThis as any).setTimeout(() => {
    refreshDebounce = null;
    void refreshFromServer();
  }, 800);
}

/** Boot-time hydrate. Stable name kept for existing call sites. Idempotent. */
export async function hydrate(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  await refreshFromServer();
}

/** Add a pin. Optimistic local update for instant UI feedback, then
 *  POST to server. The server emits `pins_changed` which triggers a
 *  background re-fetch to reconcile (so the local optimistic write
 *  gets overwritten by the canonical state). */
export async function pinMessage(item: Omit<PinnedItem, 'pinnedAt'>): Promise<void> {
  if (!item.chatId || !item.msgId) return;
  const full: PinnedItem = { ...item, pinnedAt: Date.now() };
  pinsByKey.set(key(item.chatId, item.msgId), full);
  notifyChange();
  try {
    const r = await fetch('/api/sidekick/pins', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: item.chatId,
        msg_id: item.msgId,
        role: item.role,
        text: item.text,
        timestamp: item.timestamp,
      }),
    });
    if (!r.ok) {
      let detail = '';
      try { detail = await r.text(); } catch { /* ignore */ }
      log(`[pins] POST failed: HTTP ${r.status}${detail ? ` ${detail.slice(0, 500)}` : ''}`);
      notifyPinError(r.status === 400 && /body too large/i.test(detail)
        ? 'This message is too large to pin.'
        : 'Could not pin this message.');
    }
  } catch (e: any) {
    log(`[pins] POST failed: ${e?.message ?? e}`);
    notifyPinError('Could not pin this message.');
  }
  void refreshFromServer();
}

/** Remove a pin. Optimistic local delete + DELETE on server. */
export async function unpinMessage(chatId: string, msgId: string): Promise<void> {
  if (!chatId || !msgId) return;
  if (!pinsByKey.delete(key(chatId, msgId))) return;
  notifyChange();
  try {
    const r = await fetch(
      `/api/sidekick/pins/${encodeURIComponent(chatId)}/${encodeURIComponent(msgId)}`,
      { method: 'DELETE' },
    );
    if (!r.ok) {
      let detail = '';
      try { detail = await r.text(); } catch { /* ignore */ }
      log(`[pins] DELETE failed: HTTP ${r.status}${detail ? ` ${detail.slice(0, 500)}` : ''}`);
      notifyPinError('Could not unpin this message.');
    }
  } catch (e: any) {
    log(`[pins] DELETE failed: ${e?.message ?? e}`);
    notifyPinError('Could not unpin this message.');
  }
  void refreshFromServer();
}

/** Wipe every pin across every chat. No batch endpoint server-side
 *  yet; fan out one DELETE per pin. Pin counts are typically small
 *  (single-digit to dozens) so the round-trip cost is fine. Promote
 *  to /v1/pins/clear if it becomes hot. */
export async function clearAllPins(): Promise<void> {
  if (pinsByKey.size === 0) return;
  const entries = Array.from(pinsByKey.values());
  pinsByKey.clear();
  notifyChange();
  log(`[pins] clearAllPins — ${entries.length} pin(s)`);
  await Promise.all(entries.map((p) =>
    fetch(`/api/sidekick/pins/${encodeURIComponent(p.chatId)}/${encodeURIComponent(p.msgId)}`, {
      method: 'DELETE',
    }).catch(() => {}),
  ));
  void refreshFromServer();
}

/** Sync pin check — drives the per-bubble + per-row UI repaint after
 *  hydrate() resolves. */
export function isPinned(chatId: string, msgId: string): boolean {
  if (!chatId || !msgId) return false;
  return pinsByKey.has(key(chatId, msgId));
}

/** All pins across every chat, sorted newest-first by pinnedAt.
 *  Backs the right-side pin drawer. */
export function listAllPins(): PinnedItem[] {
  return Array.from(pinsByKey.values()).sort((a, b) => b.pinnedAt - a.pinnedAt);
}

/** Synchronous count across all chats. Used by the right-drawer
 *  toggle button's banner. */
export function totalPinCount(): number {
  return pinsByKey.size;
}

/** Pins for one chat — used if we ever want a per-chat sub-list or
 *  badge on the row. Not used by the drawer (which aggregates) but
 *  cheap to expose. */
export function pinsForChat(chatId: string): PinnedItem[] {
  const out: PinnedItem[] = [];
  for (const item of pinsByKey.values()) {
    if (item.chatId === chatId) out.push(item);
  }
  return out.sort((a, b) => b.pinnedAt - a.pinnedAt);
}

function notifyChange(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('sidekick:pins-changed'));
    }
  } catch { /* non-DOM hosts (test runner) */ }
}

// Cross-device sync — proxyClient observes `pins_changed` envelopes
// on /api/sidekick/stream and dispatches `sidekick:server-pins-changed`.
// Re-fetch on every notification (debounced).
if (typeof window !== 'undefined') {
  window.addEventListener('sidekick:server-pins-changed', () => requestRefresh());
  // Foreground refresh — iOS PWA can come back after long background;
  // pull fresh on visibility change. Mirrors badge.ts's pattern.
  document?.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'visible') requestRefresh();
  });
}

// Test-only window-exposed seam — lets smokes read the in-memory pin
// state synchronously without poking at the server. Production code
// never references this.
if (typeof window !== 'undefined') {
  (window as any).__pinsDebug = {
    size: () => pinsByKey.size,
    snapshot: () => Array.from(pinsByKey.entries()),
    clearForTest: () => { pinsByKey.clear(); },
  };
}
