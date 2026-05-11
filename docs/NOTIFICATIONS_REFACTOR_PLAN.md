# Notifications + pre-notifications refactor — plan & status

This is the 4-phase plan for landing Web Push notifications in the PWA + the
opportunistic main.ts extractions that go in alongside. Written 2026-05-11
after the original plan-conversation fell out of post-compaction context.
Update as phases complete; remove entirely once Phase 3 ships.

**Total estimate**: ~22-26h focused work, 3-4 sittings (per `feedback_time_estimates.md`).

**Current status (2026-05-11 evening)**: Phase 0 **COMPLETE** (7/8 shipped + 1 documented stub). Phase 1 **COMPLETE** (3 commits: `4f4e11e` swLifecycle, `6dbe4be` backendEvents partial, `4941c2f` chatSnapshot). Phase 2 **COMPLETE** (4 commits: `5742dce` tooltip, `aefc3cc` modelCapabilities, `ed1b8ff` streamingIndicator, `6aa5428` sessionResume). Phase 3 unblocked.

---

## Phase 0 — Pre-refactor smoke nets (~4-5h, **8/8 (1 stub) — COMPLETE**)

The point: each Phase 1-2 extraction breaks some invariant if it goes wrong.
Smokes pin those invariants BEFORE the code moves, so the extraction PR's
diff lands green-or-red instantly instead of via post-merge field bug.

| Smoke | Status | Pins | Refactor target |
|---|---|---|---|
| `idb-schema-fingerprint.mjs` | ✅ `a5454a1` | fingerprint-and-wipe on schema bump (replaced the prior v1→v2 migration smoke proposal) | chat.ts snapshot |
| `tooltip-hide-on-pointerdown.mjs` | ✅ `a5454a1` | iOS-tap regression — tooltip cancelled by pointerdown before 300ms delay | tooltip |
| `streaming-label-transitions.mjs` | ✅ `a5454a1` | "sending..." → "thinking..." → "using {tool}..." state machine | streaming indicator |
| `backfill-single-flight.mjs` | ⚠️ stub | `backfillInFlight` promise dedup. backfillHistory has only one caller today AND the proxyClient adapter doesn't implement fetchHistory; the guard is dead-code-defensive. File header documents the conditions under which to promote: Phase 2 sessionResume.ts extraction wires fetchHistory back, OR new callers emerge. | session resume |
| `load-earlier-history.mjs` | ✅ `759ba68` | Pins the prepend-loop iteration direction (newest-first within the older batch). Teeth-verified: inverting `for (i = older.length-1; i >= 0; i--)` to `for (i = 0; i < older.length; i++)` triggers "chronological order violated". Mock-backend gained pagination support + integer message ids + `setHistoryFirstPageLimit` in the same commit. | session resume |
| `vision-gate-aux-fallback.mjs` | ✅ `6799566` | Pins primary-text-only + aux-fallback → buttons stay enabled with route-through tooltip. Teeth-verified: stubbing `|| !!visionFallbackModel` triggers "btn-attach should be ENABLED". | model capabilities |
| `replay-target-scroll-flash.mjs` | ✅ `6799566` | End-to-end cmdk drill: search hit click → bubble flash → flash auto-clears at 1500ms. Teeth-verified: removing `target.classList.add('search-target-flash')` triggers timeout on the flash-presence wait. | session resume |
| `notification-on-screen-system-line.mjs` + `notification-off-screen-drop.mjs` | ✅ `4b5bdeb` | **`handleNotification` integration point pinned.** On-screen → `.line.system` row with kind + content text. Off-screen → bit-identical transcript (no leak) + switch-into-chat doesn't surface the dropped notification. | backend events |

**Tier 2 (skip unless time-cheap)**: camera-button-parity, visibility-refetch, network-fail boot, idle-timeout, image-only-final, replay-no-TTS, NO_REPLY suppress, timestamp-format-1970, replyplayer-reset-on-switch, viewport-edge tooltip flip.

**Completion criterion** (met 2026-05-11): 7/8 shipped + 1 stub-with-promotion-criteria; full mocked suite at 78/80 (the 2 failures are pre-existing audio-subsystem smokes — `listen-silence-commit`, `mediasession-skip` — already in `notes/backlog/sidekick.md`, not Phase 0 concerns).

---

## Phase 1 — Pre-notifications refactors (~3-4h, **COMPLETE** 2026-05-11)

Three extractions shipped as 3 separate commits, each independently rollback-safe (per `feedback_refactor_commit_style.md`). main.ts: 4863 → 4780 LOC. chat.ts: 785 → 655 LOC. Full mocked suite stayed at 78/80 throughout.

The streaming-handler cluster — `handleReplyDelta`, `handleReplyFinal`, `handleActivity`, `handleToolEvent` + `showStreamingIndicator`/`finalizeOldestPending`/`clearStreamingIndicator`/`pendingStreamingKey`/`streamingIdleTimer` — stayed in main.ts. They share mutable state that's coherent only as one unit, and they're the natural cohort for Phase 2's `streamingIndicator.ts` extraction. Phase 3 doesn't need them split off.

### `src/swLifecycle.ts` (~180 LOC, from main.ts:3730-4024) — `4f4e11e` ✓

Existing pieces to extract:
- `waitForSwActivation`
- `markUpdateAvailable`
- refresh-button handler
- passive update detector

Why notifications needs this: Web Push registration uses
`navigator.serviceWorker.getRegistration()` + `reg.pushManager.subscribe()`.
Having a single owner of SW lifecycle gives those hooks a clean home.

### `src/backendEvents.ts` (~80 LOC, partial — `6dbe4be` ✓)

Shipped pieces:
- `handleNotification` ← **Phase 3 integration point**
- `handleUserMessage`

Deferred to Phase 2's `streamingIndicator.ts` extraction (shared mutable state forces them to move together):
- `handleReplyDelta`, `handleReplyFinal`, `handleActivity`, `handleToolEvent`
- `showStreamingIndicator`, `finalizeOldestPending`, `clearStreamingIndicator`
- `pendingStreamingKey`, `streamingIdleTimer`, `pendingBubblesByChat`

Phase 3's Web Push expansion only needs `handleNotification` to have its own owner, which it does now. The deferred handlers move when the streaming-state cluster moves.

### `src/chatSnapshot.ts` (~140 LOC, from chat.ts:20-148) — `4941c2f` ✓

Schema-fingerprint smoke already pinned the migration behavior in Phase 0 (`idb-schema-fingerprint.mjs`), so the lift was mechanical. chat.ts went 785 → 655 LOC.

**Completion criterion** (met 2026-05-11): three files extracted; main.ts shrunk by ~80 LOC + chat.ts shrunk by ~130 LOC (remaining target ~600 LOC lives with the streaming-handler cluster moved in Phase 2); all existing smokes still green; each file committed separately per `feedback_refactor_commit_style.md`.

---

## Phase 2 — Opportunistic refactors (~4-5h, **COMPLETE** 2026-05-11)

Four extractions shipped as 4 separate commits, each independently
rollback-safe. main.ts: 4780 → 4110 LOC.

| File | LOC | Commit | Notes |
|---|---|---|---|
| `src/util/tooltip.ts` | 123 | `5742dce` ✓ | Custom hover-tooltip with iOS-tap suppression. |
| `src/modelCapabilities.ts` | 226 | `aefc3cc` ✓ | models.dev caps + auxiliary vision fallback + attach-button gate. |
| `src/streamingIndicator.ts` | 303 | `ed1b8ff` ✓ | In-flight reply bubble state machine + pending-user-bubble tracker. handleActivity stays in main.ts (still consults sessionDrawer + activityRow neighbors); the deferred handlers from Phase 1's backendEvents.ts (handleReplyDelta / handleReplyFinal) didn't move yet — they cross-cut audio + canvas + replyPlayer and would inflate this commit. Defer to a follow-up when the streaming state has enough callers to justify another lift. |
| `src/sessionResume.ts` | 344 | `6aa5428` ✓ | `replaySessionMessages`, `renderHistoryMessage`, `loadEarlierHistory`, NO_REPLY_RE. The dedup + divergence-detect logic that landed 2026-05-06 + got tweaked 2026-05-11. |

**Completion criterion** (met 2026-05-11): four files extracted; main.ts shrunk by ~670 LOC (4780 → 4110); full smoke suite at 78/80 throughout (same two pre-existing audio failures). The original target of main.ts < 3500 LOC was aspirational — the residual ~4100 LOC is dominated by the voice-mode dispatcher (~1400 LOC, deferred indefinitely) plus the boot/wiring sequence which is irreducibly cross-cutting.

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
