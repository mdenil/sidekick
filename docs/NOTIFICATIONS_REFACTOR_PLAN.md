# Notifications + pre-notifications refactor — plan & status

This is the 4-phase plan for landing Web Push notifications in the PWA + the
opportunistic main.ts extractions that go in alongside. Written 2026-05-11
after the original plan-conversation fell out of post-compaction context.
Update as phases complete; remove entirely once Phase 3 ships.

**Total estimate**: ~22-26h focused work, 3-4 sittings (per `feedback_time_estimates.md`).

**Current status**: Phase 0 partially shipped (3/8 smokes). Phases 1-3 not started.

---

## Phase 0 — Pre-refactor smoke nets (~4-5h, **3/8 shipped**)

The point: each Phase 1-2 extraction breaks some invariant if it goes wrong.
Smokes pin those invariants BEFORE the code moves, so the extraction PR's
diff lands green-or-red instantly instead of via post-merge field bug.

| Smoke | Status | Pins | Refactor target |
|---|---|---|---|
| `idb-schema-fingerprint.mjs` | ✅ `a5454a1` | fingerprint-and-wipe on schema bump (replaced the prior v1→v2 migration smoke proposal) | chat.ts snapshot |
| `tooltip-hide-on-pointerdown.mjs` | ✅ `a5454a1` | iOS-tap regression — tooltip cancelled by pointerdown before 300ms delay | tooltip |
| `streaming-label-transitions.mjs` | ✅ `a5454a1` | "sending..." → "thinking..." → "using {tool}..." state machine | streaming indicator |
| `backfill-single-flight.mjs` | ❌ TODO | `backfillInFlight` promise dedup. Refactor that subtly breaks this produces silent UI dupes (the only thing stopping a triple-backfill today is one boolean). | session resume |
| `load-earlier-history.mjs` | ❌ TODO | Zero coverage today. Prepend ordering invariant could silently invert during extraction. | session resume |
| `vision-gate-aux-fallback.mjs` | ❌ TODO | "Primary text-only + aux configured → button enabled with route-through hint" path. Today's smoke uses `vision: null` so the fallback enable path is untested. | model capabilities |
| `replay-target-scroll-flash.mjs` | ❌ TODO | cmdk drill-to-message + the 1.5s `.search-target-flash` UX. Untested. | session resume |
| `notification-on-screen-system-line.mjs` + `notification-off-screen-drop.mjs` | ❌ TODO | **`handleNotification` is the Phase 3 integration point.** Pin its current behavior NOW so the upcoming expansion doesn't regress it. | backend events |

**Tier 2 (skip unless time-cheap)**: camera-button-parity, visibility-refetch, network-fail boot, idle-timeout, image-only-final, replay-no-TTS, NO_REPLY suppress, timestamp-format-1970, replyplayer-reset-on-switch, viewport-edge tooltip flip.

**Completion criterion**: 8/8 smokes shipped AND green against current main.

---

## Phase 1 — Pre-notifications refactors (~3-4h, blocker for Phase 3)

The two extractions that directly enable Phase 3's wiring, plus the migration
code that moves naturally with them.

### `src/swLifecycle.ts` (~180 LOC, from main.ts:3730-4024)

Existing pieces to extract:
- `waitForSwActivation`
- `markUpdateAvailable`
- refresh-button handler
- passive update detector

Why notifications needs this: Web Push registration uses
`navigator.serviceWorker.getRegistration()` + `reg.pushManager.subscribe()`.
Having a single owner of SW lifecycle gives those hooks a clean home.

### `src/backendEvents.ts` (~270 LOC, from main.ts:4581-4856)

Existing pieces to extract:
- `handleReplyDelta`
- `handleReplyFinal`
- `handleToolEvent`
- `handleNotification` ← **Phase 3 integration point at line 4810**
- `handleUserMessage`
- `handleActivity`

Why first: `handleNotification` is a stub today. The Phase 3 expansion
(`show OS notification when off-screen + badge update`) lands inside the
extracted file with full test coverage from the two notification smokes.

### `src/chatSnapshot.ts` (lift IDB persistence from chat.ts:20-148)

Why now: the schema-fingerprint smoke already pins the migration behavior
(Phase 0 ✓). The lift is mechanical with the smoke as backstop.

**Completion criterion**: three files extracted, main.ts shrinks by ~600 LOC, all existing smokes still green, each file committed separately (per
`feedback_refactor_commit_style.md`: structural + behavioral commits separate, each rollback-safe).

---

## Phase 2 — Opportunistic refactors (~4-5h, ship while it's fresh)

Not blocking notifications, but the audit identified these as low-risk +
high-clarity-payoff. Do in the same arc so the mental model stays loaded.

| File | LOC | From main.ts | Notes |
|---|---|---|---|
| `src/modelCapabilities.ts` | ~180 | 1721-1905 | Pure data-fetch + DOM gate. Touch when attach UI needs work. |
| `src/streamingIndicator.ts` | ~260 | 4346-4604 | Self-contained state machine for in-flight reply bubble. |
| `src/sessionResume.ts` | ~280 | 4026-4344 | `replaySessionMessages`, `renderHistoryMessage`, `loadEarlierHistory`. The dedup + divergence-detect logic that landed 2026-05-06 + got tweaked 2026-05-11 (the `cleanupAbandonedChat` fix's twin invariant). Becomes testable when lifted. |
| `src/util/tooltip.ts` | ~85 | 855-939 | 30-minute cleanup. |

**Completion criterion**: four more files extracted, main.ts < 3500 LOC (from
4863 today), full smoke suite green.

---

## Phase 3 — Web Push feature (~10-12h, the goal)

### Why this is smaller than expected (research from 2026-05-11)

- iOS 16.4+ ships Web Push for installed PWAs. Manifest already has `"display": "standalone"`. ✓
- Safari 18.4 added Declarative Web Push — simple payloads need no SW push handler. Still worth adding the `push` listener for richer cases.
- `sw.js` (CACHE_NAME v0.476) just gets a 30-line append (`push` + `notificationclick` listeners).
- Dispatcher: `web-push` (npm, pure JS, MIT, web-push-libs maintained — Bun-safe). VAPID keys generated once.
- **Tailscale Serve compat**: confirmed safe. The push service contacts the *device*, not your server. Tailscale issues real Let's Encrypt certs, browsers trust them, subscriptions persist.
- **EU restriction**: **NON-ISSUE**. Apple reversed the Feb 2024 EU PWA-restriction before iOS 17.4 GA shipped. Full standalone install + Web Push works for both Jonathan + Tom regardless of Apple ID country (eligibility gate is device location via `countryd`, not account country — both UK-based).

### Proposed module layout

```
src/notifications/
  index.ts            # init(); subscribe()/unsubscribe(); permission probe  (~80 LOC)
  subscription.ts     # PushManager.subscribe() + POST to proxy              (~120 LOC)
  sw-bridge.ts        # SW 'message' → in-app event                          (~60 LOC)
  badge.ts            # setAppBadge + unread counters per chat_id            (~80 LOC)
  permission.ts       # first-run prompt + settings-panel toggle UI          (~80 LOC)

sw.js                 # +30 LOC: push + notificationclick listeners

proxy/sidekick/notifications/
  routes.ts           # POST /api/sidekick/notifications/{subscribe,unsubscribe,test}
  storage.ts          # subscription store (SQLite, mirrors sessions.ts shape)
  dispatch.ts         # called by stream.ts when push envelope arrives for off-line subscriber

backends/hermes/plugin/__init__.py
  # NO new file. Plugin keeps emitting the existing `notification` envelope
  # it has today. Web Push concerns belong in the proxy (which already owns
  # subscription state).
```

Five client files, three server files, zero plugin files. Anything shallower bundles concerns; anything deeper is over-modularization.

**Why `src/notifications/` AND `proxy/sidekick/notifications/` separately** (decision recorded 2026-05-11):
- Existing sidekick convention is tier-based (client vs server) with different build pipelines + runtimes (`src/` → esbuild → browser ES modules; `proxy/sidekick/` → `node --experimental-strip-types`).
- Unified `features/notifications/{client/, server/}/` would force build-script special-casing. Substantial side-quest, no other features to amortize over.
- Mitigation: identical folder name on both sides so the mental model stays "same word, different tier."

### Sequencing inside Phase 3

| Step | Work | Est. |
|---|---|---|
| 3a | VAPID keys, sw.js push listener, subscription endpoint, storage | ~3h |
| 3b | Badge + permission UI in settings panel | ~2h |
| 3c | Push dispatch from SSE envelopes (off-line gating, coalesce, click-to-focus) | ~3h |
| 3d | Smoke tests: subscribe roundtrip, push delivery, badge update, click-focuses-tab | ~2h |

### Decisions baked in (2026-05-11)

1. **Subscription storage**: SQLite (clean, transactional, matches `sessions.ts` pattern).
2. **Notification policy**: start with **policy b — explicit `should_push: true` flag from plugin**. Plugin tags which envelopes are user-actionable; everything else stays in-app.
3. **VAPID keys**: public-half in git, private-half in encrypted `.env`. Generate once with `npx web-push generate-vapid-keys`.
4. **EU exclusion**: dropped — non-issue.
5. **Off-line gating** policy (what counts as "off-line for this user"): no live SSE subscription with `chat_id` matching the envelope's, OR last envelope arrival > 30s ago. Coalesce per-thread via stable notification `tag`.

**Completion criterion**: subscribe-roundtrip + off-line-dispatch + on-screen-suppress + click-focuses-tab smokes all green on real backend; tested on Jonathan's installed PWA on iPhone.

---

## Deferred indefinitely

**Voice-mode dispatcher** (~1400 LOC, main.ts:1994-3728). Biggest extraction
target but most-iterated area. Recently field-tuned (gesture machine + 280ms
tap threshold). Touch only when a behavioral change forces it (multi-mic-
source, background calls). Wrong risk/reward to lift now.

---

## How to pick this up

If resuming from a fresh context:

1. Re-read this doc.
2. `cd ~/code/sidekick && ls scripts/smoke/` to confirm which Phase 0 smokes
   exist already (cross-check against the table above).
3. Run `npm run smoke` to verify the suite is green pre-work.
4. Pick the next un-shipped Phase 0 smoke; commit each separately per
   `feedback_refactor_commit_style.md`.
5. When all 8 smokes green, move to Phase 1.

Field bugs interrupt the plan — that's fine. After each interruption, come
back here and pick up at the next un-shipped item. Don't try to memorize the
plan; this file is the source of truth.
