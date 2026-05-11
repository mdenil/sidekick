// Web Push (notifications) — client facade. Phase 3a ships subscribe /
// unsubscribe / permission roundtrip + feature probes. Phase 3b builds
// the settings-panel toggle on top; 3c wires server-side dispatch from
// SSE.
//
// What lives here:
//   init()                 — wired once from main.ts boot. Currently a
//                            no-op (subscribe is user-gesture driven so
//                            there's nothing to do at boot), but it's
//                            the natural seam for adding a passive
//                            "subscription rotated, re-register" check
//                            in 3b.
//   isPushSupported()      — re-export from subscription.ts
//   subscribe()            — re-export from subscription.ts
//   unsubscribe()          — re-export from subscription.ts
//   getActiveSubscription()— re-export from subscription.ts
//   getPermission()        — re-export from permission.ts
//   requestPermission()    — re-export from permission.ts
//
// What's NOT here:
//   - Badge / unread counters (badge.ts, lands in 3b).
//   - SW-to-page bridge (sw-bridge.ts, lands in 3c when dispatch needs
//     to nudge an open tab that a chat got a new message).

export {
  isPushSupported,
  getActiveSubscription,
  subscribe,
  unsubscribe,
} from './subscription.ts';

export {
  getPermission,
  requestPermission,
  type PushPermission,
} from './permission.ts';

/** Phase 3a no-op init seam. Lands here ahead of 3b's settings-panel
 *  toggle so main.ts only ever imports `initNotifications` from this
 *  single facade — when the passive "subscription rotated, re-register"
 *  check arrives in 3b, no main.ts touch needed. */
export async function initNotifications(): Promise<void> {
  // Reserved for 3b: passive subscription-state probe + rotation
  // detection. Intentionally inert today.
}
