// Client-side visibility reporter. Posts visibility-state changes
// to the proxy so the dispatch gate knows whether the user is actively
// engaged with a chat (within a 2s engagement window).
//
// Two fire conditions:
//
//   1. document.visibilitychange — PWA foregrounds / backgrounds.
//      The current `sessionDrawer.getViewed()` is the chat the user
//      is on; we attach it so the proxy can scope the engagement
//      signal per-chat.
//
//   2. sessionDrawer.setViewed(id) — user switches between chats
//      inside the PWA. Switching INTO a chat is functionally a
//      visibility-=-visible event for that chat (the PWA is already
//      foregrounded, but the chat-in-focus just changed).
//
// Failures are deliberately swallowed (best-effort): a missed report
// just means the gate falls back to the legacy SSE-attached +
// 30s-idle heuristic. We don't want push-notification quality issues
// blocking the PWA's main thread or spamming the console.

import { log } from '../util/log.ts';

type VisibilityState = 'visible' | 'hidden';

let lastReportedState: VisibilityState | null = null;
let lastReportedChat: string | null = null;
let initialized = false;

async function postVisibility(state: VisibilityState, chatId: string): Promise<void> {
  try {
    await fetch('/api/sidekick/notifications/visibility', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state, chat_id: chatId || undefined }),
    });
  } catch (e: any) {
    // Network drops happen; the next visibilitychange will re-report.
    // Quietly diagnostic-log only — no user-facing surfacing.
    log(`[visibility] report failed (${state}, ${chatId || '-'}): ${e?.message ?? e}`);
  }
}

/** Idempotent. Reports only when state OR chat actually changed —
 *  avoids burning HTTP roundtrips on no-op events. */
function maybeReport(state: VisibilityState, chatId: string): void {
  if (state === lastReportedState && chatId === lastReportedChat) return;
  lastReportedState = state;
  lastReportedChat = chatId;
  void postVisibility(state, chatId);
}

/** Wire the listeners. Called once at boot from main.ts. The
 *  getViewed callback returns the currently-viewed chat id; we read
 *  it lazily so this module doesn't depend on sessionDrawer (avoids
 *  a cycle and keeps the API tiny). */
export function initVisibilityReporting(getViewed: () => string | null): void {
  if (initialized) return;
  initialized = true;

  const compute = (): { state: VisibilityState; chatId: string } => {
    const state: VisibilityState =
      typeof document !== 'undefined' && document.visibilityState === 'hidden'
        ? 'hidden' : 'visible';
    const chatId = getViewed() || '';
    return { state, chatId };
  };

  // Initial report so the proxy knows the boot-time state without
  // needing to wait for the first visibilitychange.
  const first = compute();
  maybeReport(first.state, first.chatId);

  // document.visibilitychange covers OS-level PWA background/foreground.
  document.addEventListener('visibilitychange', () => {
    const { state, chatId } = compute();
    maybeReport(state, chatId);
  });
}

/** Reports the user switched to chat `chatId`. Called from
 *  sessionDrawer.setViewed. Reports state=visible (the only sensible
 *  state if the user just clicked a chat); the proxy times-out the
 *  signal naturally after the engagement window. */
export function reportChatSwitch(chatId: string | null): void {
  if (!initialized) return;
  const id = chatId || '';
  // Only fire when actually changing chat — backbone re-renders
  // (resume() called twice for the same chat) shouldn't burn an HTTP.
  if (id === lastReportedChat && lastReportedState === 'visible') return;
  maybeReport('visible', id);
}
