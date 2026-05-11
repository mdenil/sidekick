// Notification permission probe + request helpers. Phase 3a keeps this
// minimal — the settings-panel toggle that actually drives subscribe()
// lands in Phase 3b. The split exists so the permission state can be
// observed without coupling to the UI (e.g. for a future "your push
// notifications are paused — re-enable in iOS settings" banner).

/** Three-way state of the user's permission grant. `unavailable` means
 *  the browser doesn't expose the Notification API at all (older
 *  WebKit, non-PWA Safari on iOS < 16.4). */
export type PushPermission = 'granted' | 'denied' | 'default' | 'unavailable';

export function getPermission(): PushPermission {
  if (typeof Notification === 'undefined') return 'unavailable';
  return Notification.permission as PushPermission;
}

/** Request permission from the user. MUST be called from a user gesture
 *  (button click) — Safari + Chrome both ignore programmatic calls.
 *  Returns the resolved permission, NOT a boolean, because "default"
 *  (user dismissed) is a different state from "denied". */
export async function requestPermission(): Promise<PushPermission> {
  if (typeof Notification === 'undefined') return 'unavailable';
  try {
    const result = await Notification.requestPermission();
    return result as PushPermission;
  } catch {
    return 'denied';
  }
}
