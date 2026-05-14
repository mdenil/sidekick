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
import * as chat from './chat.ts';
import * as renderedMessages from './renderedMessages.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import * as badge from './notifications/badge.ts';

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
    log(`notification (off-screen) chat=${chatId} kind=${kind} — badge++`);
    return;
  }
  // Mirror sessionResume.renderHistoryMessage's notification branch
  // so live-render and reload-render produce identical DOM. The
  // sidekick_id is the dedup key — if hermes plugin persisted the
  // row (2026-05-14 change), reload's history fetch will surface
  // it AND the renderedMessages upsert dedups against this
  // data-message-id automatically.
  const emoji = kind === 'cron' ? '⏰' : '🔔';
  let displayText = content || '';
  if (kind === 'cron') {
    // Strip the scheduler boilerplate — same parser the proxy uses
    // for the push payload + sessionResume uses for history rendering.
    // Keeps the transcript readable when the user IS viewing the chat.
    const headerRe = /^Cronjob Response:\s*(.+?)\s*\n\(job_id:\s*([^)]+)\)\s*\n-+\s*\n+([\s\S]*?)(?:\n+To stop or manage this job[^\n]*\.?\s*)?$/;
    const match = headerRe.exec(displayText);
    if (match) {
      const taskName = match[1].trim();
      const agentBody = match[3].trim();
      displayText = `**${taskName}**\n\n${agentBody}`;
    }
  }
  const speaker = kind ? `${emoji} ${kind}` : (emoji || 'Notification');
  chat.addLine(speaker, displayText, 'system notification', {
    markdown: true,
    timestamp: Date.now(),
    messageId: sidekickId || undefined,
  });
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
  // Defensive: an empty/missing text on a user_message envelope must
  // not WIPE an existing populated bubble. The upsert below is keyed
  // by messageId, so a second envelope for the same id with text=""
  // would otherwise overwrite the bubble's text and the user sees
  // their own message vanish. Production hermes envelopes always
  // carry text, but a serialization race, a future codepath that
  // emits a metadata-only ping, or a partial replay must not clobber
  // the user's words. Pinned by
  // scripts/smoke/user-message-empty-text-noop.mjs.
  if (!text) {
    log(`user_message (empty text) chat=${conversation} msgId=${messageId} — skip to preserve existing bubble`);
    return;
  }
  // Idempotent — originating device's optimistic bubble is already
  // registered under this id, so this collapses to a no-op upsert
  // (text is unchanged, status stays 'finalized'). Other devices
  // create the bubble for the first time.
  renderedMessages.upsert(messageId, {
    role: 'user',
    text,
    status: 'finalized',
    speaker: 'You',
    cls: 's0',
  });
}
