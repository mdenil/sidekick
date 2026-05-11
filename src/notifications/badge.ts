// App-icon badge — wraps the Badging API (setAppBadge/clearAppBadge) +
// keeps an in-memory unread-by-chat counter so the badge total can be
// computed without re-walking IDB on every push arrival.
//
// Phase 3b adds the wrapper + counter; Phase 3c wires push-arrival +
// chat-focus events. setAppBadge is supported on installed PWAs on
// iOS 16.4+, macOS 14+, Chrome desktop, and most Android browsers. The
// wrapper is null-safe: hosts without the API silently skip the call
// rather than throwing.

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
}

/** Clear the unread counter for `chatId` and re-sync. Called when the
 *  user opens the chat (replaySessionMessages would be the natural
 *  spot, but Phase 3c will wire it from the sessionDrawer.setViewed
 *  observer to capture every focus path). */
export function clearUnread(chatId: string): void {
  if (!chatId) return;
  if (unreadByChat.delete(chatId)) void syncBadge();
}

/** Wipe everything — used by chat.clear() and the "reset state" flow.
 *  Idempotent. */
export function clearAllUnread(): void {
  if (unreadByChat.size === 0) return;
  unreadByChat.clear();
  void syncBadge();
}

/** Snapshot of the unread map. Returns a fresh copy. Useful for the
 *  drawer's per-chat unread chip (Phase 3c). */
export function snapshotUnread(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of unreadByChat) out[k] = v;
  return out;
}
