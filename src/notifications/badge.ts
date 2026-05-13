// App-icon badge — wraps the Badging API (setAppBadge/clearAppBadge) +
// keeps an in-memory unread-by-chat counter so the badge total can be
// computed without re-walking IDB on every push arrival.
//
// Phase 3b adds the wrapper + counter; Phase 3c wires push-arrival +
// chat-focus events. setAppBadge is supported on installed PWAs on
// iOS 16.4+, macOS 14+, Chrome desktop, and most Android browsers. The
// wrapper is null-safe: hosts without the API silently skip the call
// rather than throwing.

import { log } from '../util/log.ts';
import { loadMarkedUnread, saveMarkedUnread } from './unreadStore.ts';

const unreadByChat = new Map<string, number>();

// Sticky user-marked-unread state. Distinct from the natural
// `unreadByChat` counter (push arrivals, off-screen reply_finals)
// because it shouldn't auto-clear when the user opens the chat —
// the whole point is "I marked this as a thing to come back to."
// Cleared only by an explicit user action (Mark as read menu item,
// or Mark all read in Settings).
//
// Persisted to IDB via unreadStore so the marker survives reload and
// service-worker updates. The natural counter is deliberately NOT
// persisted (it's an ephemeral attention-window signal — see
// unreadStore.ts header for rationale).
const markedUnread = new Set<string>();
let markedLoaded = false;

/** Sum of unread counts across every chat. The number that lands on
 *  the app-icon badge. Marked-unread chats contribute exactly 1 each
 *  unless they ALSO have natural unread events (in which case the
 *  natural count already dominates and the marker doesn't double-count).
 *  Math: per-chat = max(natural, markedAsOne) where markedAsOne = 1
 *  if marked else 0. This keeps "I marked one chat unread" from
 *  inflating the badge if a push then arrived for that same chat. */
function totalUnread(): number {
  let total = 0;
  const seen = new Set<string>();
  for (const [id, n] of unreadByChat) {
    total += Math.max(n, markedUnread.has(id) ? 1 : 0);
    seen.add(id);
  }
  // Chats marked-unread without any natural events yet — add 1 each.
  for (const id of markedUnread) {
    if (!seen.has(id)) total += 1;
  }
  return total;
}

/** Push the current unread total to the OS via Badging API. Silently
 *  no-ops on browsers without the API. Awaitable but failure is
 *  swallowed — badges are decorative; failure shouldn't break flow.
 *
 *  Also dismisses any service-worker notifications when the total
 *  reaches 0. On iOS PWA the visible icon badge is driven by TWO
 *  sources: the W3C Badging API (which clearAppBadge handles) AND
 *  the OS's count of undismissed notifications. Without closing the
 *  SW notifications, swiping the banner away or dismissing it via
 *  Notification Center still leaves the badge stuck (Jonathan field
 *  bug 2026-05-13: PWA badge stuck at "1" even after Mark-all-read +
 *  clearAppBadge fired). getNotifications + close() clears the
 *  OS-level state. */
async function syncBadge(): Promise<void> {
  const total = totalUnread();
  try {
    if (total > 0) {
      if (typeof navigator.setAppBadge === 'function') await navigator.setAppBadge(total);
    } else {
      if (typeof navigator.clearAppBadge === 'function') await navigator.clearAppBadge();
      // Also dismiss any still-visible SW notifications. The icon
      // badge on iOS PWA also reflects the count of undismissed
      // notifications — clearAppBadge alone leaves it stuck if push
      // banners are still in Notification Center.
      await closeAllSwNotifications();
    }
  } catch {
    // No-op on TypeError (unsupported) / SecurityError (not installed).
  }
}

/** Close every service-worker-rendered notification for this PWA.
 *  Best-effort: hosts without SW or with no active registration
 *  silently no-op. Failure swallowed — badge sync is decorative. */
async function closeAllSwNotifications(): Promise<void> {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return;
    const ns = await reg.getNotifications();
    for (const n of ns) {
      try { n.close(); } catch { /* tab vanished mid-loop */ }
    }
    if (ns.length > 0) log(`[badge] closed ${ns.length} SW notification(s)`);
  } catch { /* defensive */ }
}

/** Increment the unread counter for `chatId` and re-sync the badge.
 *  Phase 3c wires this to the push-arrival event so off-screen chats
 *  accumulate badge weight without the user having to switch in. */
export function incrementUnread(chatId: string, delta: number = 1): void {
  if (!chatId) return;
  const prev = unreadByChat.get(chatId) || 0;
  unreadByChat.set(chatId, prev + delta);
  void syncBadge();
  notifyChange();
}

/** Clear the natural unread counter for `chatId` and re-sync. Called
 *  when the user opens the chat (sessionDrawer.setViewed). Critically
 *  does NOT touch the sticky `markedUnread` flag — that's user state
 *  that should survive a chat focus by design (WhatsApp semantic).
 *  Use `unmarkUnread(chatId)` for the explicit "I'm done with this"
 *  action that should also clear the marker. */
export function clearUnread(chatId: string): void {
  if (!chatId) return;
  if (unreadByChat.delete(chatId)) {
    void syncBadge();
    notifyChange();
  }
}

/** Sticky "remind me about this" flag. Mirrors WhatsApp's Mark unread:
 *  the chat stays flagged in the sidebar even after the user focuses
 *  it, until they explicitly mark it read again. Persisted to IDB.
 *
 *  No-ops if already marked (idempotent). */
export function markUnread(chatId: string): void {
  if (!chatId || markedUnread.has(chatId)) return;
  markedUnread.add(chatId);
  void saveMarkedUnread(markedUnread);
  void syncBadge();
  notifyChange();
  log(`[badge] markUnread chat=${chatId}`);
}

/** Clear the sticky marked-unread flag for `chatId`. Independent of
 *  the natural counter — `clearUnread(chatId)` handles that. The row's
 *  3-dots menu toggles between markUnread / unmarkUnread; Settings's
 *  "Mark all read" calls `clearAllUnread()` which wipes both. */
export function unmarkUnread(chatId: string): void {
  if (!chatId || !markedUnread.has(chatId)) return;
  markedUnread.delete(chatId);
  void saveMarkedUnread(markedUnread);
  void syncBadge();
  notifyChange();
  log(`[badge] unmarkUnread chat=${chatId}`);
}

/** True if the user has explicitly marked this chat unread. The row
 *  3-dots menu uses this to pick between "Mark as unread" and "Mark
 *  as read" labels. */
export function isMarkedUnread(chatId: string): boolean {
  return markedUnread.has(chatId);
}

/** Restore the persisted marked-unread set on boot. Idempotent — only
 *  loads once even if called multiple times (e.g. from multiple init
 *  paths). Caller is expected to await before the drawer renders for
 *  the first time so the indicators paint with correct state. */
export async function hydrateMarkedUnread(): Promise<void> {
  if (markedLoaded) return;
  markedLoaded = true;
  const ids = await loadMarkedUnread();
  for (const id of ids) markedUnread.add(id);
  if (ids.length > 0) {
    void syncBadge();
    notifyChange();
    log(`[badge] hydrated ${ids.length} marked-unread chat(s) from IDB`);
  }
}

/** Wipe everything — used by chat.clear() and the "reset state" flow,
 *  also surfaced as a "Mark all read" button in Settings → Notifications
 *  so the user has an escape hatch when the badge sticks on an event
 *  they don't care about. Idempotent on the in-memory maps; ALWAYS syncs
 *  the OS-level badge.
 *
 *  Wipes BOTH the natural counter AND the sticky markedUnread set —
 *  "Mark all read" should be a clean slate.
 *
 *  Field bug 2026-05-12 (Jonathan): the OS app-icon badge can show "1"
 *  while `unreadByChat` is already empty — iOS PWA caches the badge
 *  value across reloads / SW updates, so the in-memory map and the OS
 *  state can drift. The earlier early-return (`if (size===0) return`)
 *  meant Mark all read did nothing in this exact case. Drop the bail
 *  and always force a clearAppBadge call so the OS state is always
 *  reachable from the button. */
export function clearAllUnread(): void {
  const hadEntries = unreadByChat.size > 0 || markedUnread.size > 0;
  unreadByChat.clear();
  if (markedUnread.size > 0) {
    markedUnread.clear();
    void saveMarkedUnread(markedUnread);
  }
  // Always sync — even when the maps were already empty. syncBadge picks
  // clearAppBadge() when total is 0, which is the OS-level reset the
  // user is actually trying to invoke.
  void syncBadge();
  log(`[badge] clearAllUnread invoked (hadEntries=${hadEntries})`);
  if (hadEntries) notifyChange();
}

/** Snapshot of the unread map. Returns a fresh copy. Used by the
 *  drawer for repainting per-chat indicators + by the Notifications
 *  settings panel for the "unread by chat" readout. */
export function snapshotUnread(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of unreadByChat) out[k] = v;
  return out;
}

/** Synchronous count for a single chat. Used by sessionDrawer's
 *  renderRow to stamp `.unread` + the count chip per-row without
 *  walking the whole map on every render. Sticky marker adds 1
 *  ONLY when there's no natural unread already — so marking a chat
 *  with active unreads doesn't inflate its chip. */
export function unreadFor(chatId: string): number {
  const natural = unreadByChat.get(chatId) || 0;
  if (markedUnread.has(chatId)) return Math.max(natural, 1);
  return natural;
}

/** Sum of unread across all chats — used by the Settings panel readout
 *  to confirm the badge total without exposing internal map state. */
export function totalUnreadCount(): number {
  return totalUnread();
}

/** Fire a `sidekick:unread-changed` event on `window` so other modules
 *  (sessionDrawer, settings panel) can repaint without polling.
 *  Wrapped defensively — non-DOM hosts (Node test runner) shouldn't
 *  break the badge update path. */
function notifyChange(): void {
  try {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('sidekick:unread-changed'));
    }
  } catch { /* defensive — non-DOM hosts */ }
}
