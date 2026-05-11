// Adapter-envelope handlers — the inbound side of the BackendAdapter
// contract. Extracted 2026-05-11 for the Phase 1 / pre-notifications
// refactor (see docs/NOTIFICATIONS_REFACTOR_PLAN.md).
//
// Scope intentionally narrow: only `handleNotification` and
// `handleUserMessage` live here today. The streaming-bubble cluster —
// `handleReplyDelta`, `handleReplyFinal`, `handleActivity`,
// `handleToolEvent`, plus the streaming-state helpers
// (`showStreamingIndicator`, `finalizeOldestPending`,
// `clearStreamingIndicator`, `pendingStreamingKey`, the idle timer)
// — remains in main.ts until Phase 2's `streamingIndicator.ts`
// extraction. Those handlers all share mutable streaming state that
// would need to move with them; pulling them piecemeal would scatter
// the state machine across two modules.
//
// Why this module exists in Phase 1 anyway: `handleNotification` is
// the Phase 3 (Web Push) integration point — the off-screen branch
// will expand into "post an OS notification + set badge + wake the
// SW push handler." Having it in its own module means that expansion
// lands as a focused diff inside `backendEvents.ts` rather than a
// ~200-line touch in main.ts.

import { log } from './util/log.ts';
import * as chat from './chat.ts';
import * as renderedMessages from './renderedMessages.ts';
import * as sessionDrawer from './sessionDrawer.ts';

/** Push notification handler — cron output, /background results,
 *  scheduled reminders. Backends that support out-of-band push (today:
 *  hermes-gateway via /api/sidekick/notifications) call this; others
 *  never fire it. v1: append a styled system row in the targeted chat
 *  if it's currently being viewed. Off-screen chats get a no-op for
 *  now (a future iteration adds a drawer-side unread badge). Browser
 *  Push API / APNS / Web Push integration is a separate sprint
 *  (Phase 3 — see docs/NOTIFICATIONS_REFACTOR_PLAN.md). */
export function handleNotification({ chatId, kind, content }: any): void {
  // Off-screen chat — drop for v1. The drawer doesn't yet have an
  // unread-badge surface; refresh on switch will pick up the message
  // via the next listSessions / resumeSession round-trip.
  if (chatId && chatId !== sessionDrawer.getViewed()) {
    log(`notification (off-screen) chat=${chatId} kind=${kind}`);
    return;
  }
  const label = kind ? `notification — ${kind}` : 'notification';
  const text = content ? `(${label}) ${content}` : `(${label})`;
  chat.addSystemLine(text);
}

/** Cross-device user-message broadcast handler. The upstream emits a
 *  `user_message` envelope as soon as a /v1/responses POST lands —
 *  every connected device receives it, including the originator.
 *
 *  Dedup: the originating device pre-minted `messageId` for its
 *  optimistic bubble (see sendTypedMessage) and registered it in
 *  renderedMessages. The upsert below is idempotent on that key, so
 *  for the originator this is a no-op (entry exists; status doesn't
 *  change; text doesn't change). For every OTHER device the entry
 *  doesn't exist yet — upsert creates a fresh user bubble.
 *
 *  Off-screen filtering: like reply_delta, drop only when the
 *  conversation is explicitly different from the viewed one. When
 *  getViewed() is null (boot races), render — there's no on-screen
 *  session to protect. */
export function handleUserMessage({ conversation, text, messageId }: any): void {
  if (!messageId) return;
  const viewed = sessionDrawer.getViewed();
  if (viewed && conversation && conversation !== viewed) {
    log(`user_message (off-screen) chat=${conversation} msgId=${messageId}`);
    return;
  }
  // Idempotent — originating device's optimistic bubble is already
  // registered under this id, so this collapses to a no-op upsert
  // (text is unchanged, status stays 'finalized'). Other devices
  // create the bubble for the first time.
  renderedMessages.upsert(messageId, {
    role: 'user',
    text: text || '',
    status: 'finalized',
    speaker: 'You',
    cls: 's0',
  });
}
