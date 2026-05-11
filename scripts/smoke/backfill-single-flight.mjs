// Phase 0 smoke (pre-refactor) — INTENTIONAL STUB.
//
// The audit listed this as tier-1 to pin backfillHistory's
// `backfillInFlight` single-flight promise dedup (main.ts:4375-4437).
// On closer look the assertion isn't currently testable as a smoke:
//
//   1. proxyClient.ts (the only active adapter) doesn't implement
//      `fetchHistory`. The dispatcher at src/backend.ts:77 returns []
//      when the adapter omits it. So backfillHistory's `messages`
//      array is always empty → it returns at line 4406 before any
//      append. No observable side effect to assert against.
//
//   2. backfillHistory has exactly one caller (main.ts:1055, inside
//      boot()). Visibility / online / pageshow handlers do NOT call
//      it — they call reconcileActiveChat instead, which fetches
//      /messages (a different code path with its own dedup via
//      renderedMessages.upsert idempotency).
//
//   3. So the "refactor that subtly breaks dedup → silent UI dupes"
//      symptom can't happen via this code path. The single-flight
//      guard is dead-code-defensive against a re-introduction of
//      multi-caller scenarios.
//
// When to revisit:
//   - Phase 2's sessionResume.ts extraction. If that refactor wires
//     fetchHistory back into the proxyClient adapter, OR adds new
//     callers of backfillHistory, the single-flight guard becomes
//     load-bearing again — re-stub this file then.
//   - Today's right move is `STATUS='stub'` so the suite doesn't
//     count it as a missing-but-required gate.

export const NAME = 'backfill-single-flight';
export const DESCRIPTION = 'backfillInFlight promise dedup (currently no observable side effect — see file header)';
export const STATUS = 'stub';
export const BACKEND = 'mocked';

export default async function run() {
  // No-op stub. See file header for why this isn't implemented as a
  // real smoke today.
}
