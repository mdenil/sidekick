// Adapter-envelope handlers — the inbound side of the BackendAdapter
// contract. Extracted 2026-05-11 for the Phase 1 / pre-notifications
// refactor.
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
import * as transcriptStore from './transcript/store.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import * as badge from './notifications/badge.ts';
import * as inAppBanner from './notifications/inAppBanner.ts';

/** Push notification handler — cron output, /background results,
 *  scheduled reminders. Backends that support out-of-band push (today:
 *  hermes-gateway via /api/sidekick/notifications) call this; others
 *  never fire it. For the currently-viewed chat: append a styled
 *  notification row matching the persisted transcript shape (so
 *  reload finds the same data-message-id and dedups). For off-screen
 *  chats: bump the badge counter. */
export function handleNotification({ chatId, kind, content, sidekickId }: any): void {
  // Off-screen chat — bump the app-icon badge so the user notices
  // there's a new event waiting in another chat. clearUnread fires
  // from sessionDrawer.setViewed when they switch in. The system
  // notification (OS-level) is dispatched separately by the proxy
  // (proxy/sidekick/notifications/dispatch.ts); this is the in-app
  // counterpart for badge state.
  if (chatId && chatId !== sessionDrawer.getViewed()) {
    badge.incrementUnread(chatId);
    // In-app banner — surface the notification at the top of the
    // viewport so the user actually notices it (the badge alone is
    // a "next time you scan the drawer" signal, not "look at me NOW").
    // Tap → drills into the chat + scrolls to the notification row.
    inAppBanner.show({
      chatId,
      kind: kind || '',
      content: content || '',
      sidekickId: typeof sidekickId === 'string' ? sidekickId : null,
      chatLabel: sessionDrawer.getTitleForChat?.(chatId) || undefined,
    });
    log(`notification (off-screen) chat=${chatId} kind=${kind} — badge++ + banner`);
    return;
  }
  // On-screen notification — push into the store. Projection renders
  // it via the reconciler's notification path; same shape as durable
  // rows that come back through /messages later (deduped via sidekick_id).
  let displayText = content || '';
  if (kind === 'cron') {
    // Strip the scheduler boilerplate so the in-chat row reads cleanly.
    const headerRe = /^Cronjob Response:\s*(.+?)\s*\n\(job_id:\s*([^)]+)\)\s*\n-+\s*\n+([\s\S]*?)(?:\n+To stop or manage this job[^\n]*\.?\s*)?$/;
    const match = headerRe.exec(displayText);
    if (match) {
      const taskName = match[1].trim();
      const agentBody = match[3].trim();
      displayText = `**${taskName}**\n\n${agentBody}`;
    }
  }
  if (chatId) {
    transcriptStore.appendInflight(chatId, {
      type: 'notification',
      chat_id: chatId,
      kind: kind || 'notification',
      content: displayText,
      sidekick_id: typeof sidekickId === 'string' ? sidekickId : undefined,
    });
    void badge.clearUnread(chatId);
  }
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
  if (!messageId || !conversation) return;
  // Defensive: empty text must not wipe an existing bubble. Production
  // envelopes always carry text; future metadata-only pings shouldn't
  // clobber the user's words.
  if (!text) {
    log(`user_message (empty text) chat=${conversation} msgId=${messageId} — skip to preserve existing bubble`);
    return;
  }
  // Push into the store unconditionally — background chats need to
  // know about the echo too so a switch-back finds the right state.
  transcriptStore.appendInflight(conversation, {
    type: 'user_message',
    chat_id: conversation,
    message_id: messageId,
    text,
  });
  // Clear the matching pendingSend on the originator — projection
  // dedups against inflight regardless, but cleaning up keeps the
  // store hygienic.
  transcriptStore.clearPendingSend(conversation, messageId);
}
