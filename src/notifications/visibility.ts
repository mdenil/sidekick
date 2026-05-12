// Client-side visibility reporter. Posts visibility-state changes
// to the proxy so the dispatch gate knows whether the user is actively
// engaged with a chat (within a 2s engagement window).
//
// Three fire conditions:
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
//   3. Heartbeat — every HEARTBEAT_MS while page.visibilityState is
//      'visible' AND a chat is viewed. Without this, sitting on the
//      same chat for >2s with no events lets the server-side
//      timestamp age past ENGAGED_WINDOW_MS and the very next reply
//      gets a spurious push banner (Jonathan field bug 2026-05-12).
//
// Failures are deliberately swallowed (best-effort): a missed report
// just means the gate falls back to the legacy SSE-attached +
// 30s-idle heuristic. We don't want push-notification quality issues
// blocking the PWA's main thread or spamming the console.

import { log } from '../util/log.ts';

type VisibilityState = 'visible' | 'hidden';

// Heartbeat cadence — must be strictly less than the proxy-side
// ENGAGED_WINDOW_MS (notifications/visibility.ts, currently 2000ms)
// so a single dropped request can't open a window where the server
// thinks the user isn't engaged. 1500ms leaves a 500ms safety margin.
const HEARTBEAT_MS = 1500;

let lastReportedState: VisibilityState | null = null;
let lastReportedChat: string | null = null;
let initialized = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let getViewedRef: (() => string | null) | null = null;

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
  getViewedRef = getViewed;

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

  // Heartbeat — keeps the proxy's engagement timestamp fresh while the
  // user sits on a chat. Without this, the timestamp ages past the 2s
  // server window and any new reply gets a spurious push banner
  // (Jonathan field bug 2026-05-12). Bypasses maybeReport's dedup
  // gating so the timestamp REFRESHES each tick — that's the entire
  // point. Suppressed while page is hidden (the 'hidden' state from
  // visibilitychange already informs the server) and when no chat is
  // viewed.
  heartbeatTimer = setInterval(() => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible') return;
    const chatId = getViewedRef?.() || '';
    if (!chatId) return;
    void postVisibility('visible', chatId);
  }, HEARTBEAT_MS);
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
