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

const unreadByChat = new Map<string, number>();

/** Sum of unread counts across every chat. The number that lands on
 *  the app-icon badge. */
function totalUnread(): number {
  let total = 0;
  for (const n of unreadByChat.values()) total += n;
  return total;
}

/** Push the current unread total to the OS via Badging API. Silently
 *  no-ops on browsers without the API. Awaitable but failure is
 *  swallowed — badges are decorative; failure shouldn't break flow. */
async function syncBadge(): Promise<void> {
  const total = totalUnread();
  try {
    if (total > 0) {
      if (typeof navigator.setAppBadge === 'function') await navigator.setAppBadge(total);
    } else {
      if (typeof navigator.clearAppBadge === 'function') await navigator.clearAppBadge();
    }
  } catch {
    // No-op on TypeError (unsupported) / SecurityError (not installed).
  }
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

/** Clear the unread counter for `chatId` and re-sync. Called when the
 *  user opens the chat (replaySessionMessages would be the natural
 *  spot, but Phase 3c will wire it from the sessionDrawer.setViewed
 *  observer to capture every focus path). */
export function clearUnread(chatId: string): void {
  if (!chatId) return;
  if (unreadByChat.delete(chatId)) {
    void syncBadge();
    notifyChange();
  }
}

/** Wipe everything — used by chat.clear() and the "reset state" flow,
 *  also surfaced as a "Mark all read" button in Settings → Notifications
 *  so the user has an escape hatch when the badge sticks on an event
 *  they don't care about. Idempotent on the in-memory map; ALWAYS syncs
 *  the OS-level badge.
 *
 *  Field bug 2026-05-12 (Jonathan): the OS app-icon badge can show "1"
 *  while `unreadByChat` is already empty — iOS PWA caches the badge
 *  value across reloads / SW updates, so the in-memory map and the OS
 *  state can drift. The earlier early-return (`if (size===0) return`)
 *  meant Mark all read did nothing in this exact case. Drop the bail
 *  and always force a clearAppBadge call so the OS state is always
 *  reachable from the button. */
export function clearAllUnread(): void {
  const hadEntries = unreadByChat.size > 0;
  unreadByChat.clear();
  // Always sync — even when the map was already empty. syncBadge picks
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
 *  walking the whole map on every render. */
export function unreadFor(chatId: string): number {
  return unreadByChat.get(chatId) || 0;
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
