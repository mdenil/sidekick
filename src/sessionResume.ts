// Session-resume rendering — drives the transcript when the user
// switches into a chat (initial replay, drawer click, cmdk search hit,
// service-worker resume) and when they scroll to top to load earlier.
// Extracted from main.ts 2026-05-11 for the Phase 2 / pre-notifications
// refactor.
//
// Three exports + an init for plumbing:
//
//   replaySessionMessages(id, messages, pagination?, targetMsg?, inflight?)
//     The big one. Same-session vs different-session policy, render
//     batching, divergence-detection self-heal, pagination registration,
//     cmdk drill-to-message scroll-and-flash, inflight envelope replay.
//
//   renderHistoryMessage(m, label, mode?, batch?)
//     Shared per-message renderer for both initial replay (append) and
//     load-earlier (prepend, batched). Picks sidekick_id over integer id
//     so the IDB-cached bubble dedupes against history-replay correctly.
//
//   loadEarlierHistory(beforeId)
//     Scroll-to-top lazy-load. Walks the older[] array oldest→newest so
//     prepends end up in chronological order at the top.
//
// Module-private state: viewedSessionForLoadEarlier. Pinned by
// replaySessionMessages, read by loadEarlierHistory. Lives here rather
// than in main.ts so the load-earlier callback is self-contained.
//
// Plumbing: the module needs `getAgentLabel`, `setComposerReadOnly`,
// and a `setHistoryLoaded` callback (the backfill flag in main.ts is
// flipped by replaySessionMessages so backfillHistory short-circuits
// after a resume). Wired once by initSessionResume.

import { log, diag } from './util/log.ts';
import * as chat from './chat.ts';
import * as renderedMessages from './renderedMessages.ts';
import * as activityRow from './activityRow.ts';
import * as replyNavigator from './audio/turn-based/replyNavigator.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import * as backend from './backend.ts';

/** Pattern for assistant replies the plugin signals as "no reply" (the
 *  agent chose to stay silent). We drop them from the rendered
 *  transcript rather than show an empty bubble. Exported because the
 *  live SSE handlers in main.ts apply the same filter on reply_delta /
 *  reply_final before upserting. */
export const NO_REPLY_RE = /^\s*NO[-_]?(?:REPL(?:Y)?)?\.?\s*$/i;

let getAgentLabelRef: () => string = () => 'Agent';
let setComposerReadOnlyRef: (readOnly: boolean, source?: string) => void = () => {};
let setHistoryLoadedRef: () => void = () => {};

/** Session id the chat is currently viewing — used by the load-earlier
 *  callback so it knows which session to fetch older messages for.
 *  Updated by replaySessionMessages. */
let viewedSessionForLoadEarlier: string | null = null;

/** Wire the module's callbacks into main.ts. Called once at boot. */
export function initSessionResume(opts: {
  getAgentLabel: () => string;
  setComposerReadOnly: (readOnly: boolean, source?: string) => void;
  setHistoryLoaded: () => void;
}): void {
  getAgentLabelRef = opts.getAgentLabel;
  setComposerReadOnlyRef = opts.setComposerReadOnly;
  setHistoryLoadedRef = opts.setHistoryLoaded;
}

/** Render a full set of session messages, replacing the current
 *  transcript. Same-session resumes (visibility flip, SSE reconnect,
 *  post-turn drawer refresh) skip the clear so renderedMessages.upsert
 *  can reconcile in place without the blank-and-repaint flicker.
 *  resume() can fire onResumeCb multiple times for the same id (cache-
 *  cb + server-cb when results match); when the viewed id is unchanged
 *  we skip the clear to avoid double-append. */
export function replaySessionMessages(
  id: string,
  messages: any[],
  pagination?: { firstId: number | null; hasMore: boolean },
  targetMessageId?: string,
  inflight?: any[],
): void {
  const viewed = sessionDrawer.getViewed();
  const sameSession = viewed === id;
  diag(
    `[render-dupe] replaySessionMessages enter chat_id=${id} ` +
    `viewed=${viewed ?? ''} sameSession=${sameSession} ` +
    `msgCount=${messages.length} ` +
    `mode=${sameSession ? 'merge-existing' : 'clear-and-repopulate'} ` +
    `targetMessageId=${targetMessageId ?? ''} ` +
    `firstId=${pagination?.firstId ?? ''} hasMore=${pagination?.hasMore ?? ''}`,
  );
  if (!sameSession) {
    renderedMessages.clear();
    // Activity rows belong to the previous chat's transcript; only
    // clear when actually switching sessions. A same-session resume
    // (visibility flip, SSE reconnect, post-turn drawer refresh)
    // would otherwise wipe the just-rendered tool-call summary,
    // leaving no record of what the agent did.
    activityRow.clearAll();
    // Reset the per-reply playback pointer + cancel any in-flight
    // replay so a stale `.replaying` highlight doesn't survive into
    // the new transcript and BT skip-fwd starts from the new chat's
    // most-recent reply.
    replyNavigator.reset();
  }
  setHistoryLoadedRef();  // we just populated history ourselves; skip backfill
  // Tell the drawer which session is ACTUALLY on screen — covers edge
  // cases where the adapter's conversationName diverges from what the
  // user is reading (superseded tokens, failed resumes, boot paths).
  sessionDrawer.setViewed(id);
  // Composer read-only when viewing a non-sidekick chat (cross-platform
  // send isn't supported — would route through the wrong adapter).
  const source = sessionDrawer.getSourceForChat(id);
  setComposerReadOnlyRef(source !== 'sidekick', source);
  // Refresh server-side session list — handleReplyFinal also refreshes
  // when a turn completes, but if the user switches sessions mid-flight
  // (which aborts the SSE stream client-side), response.completed never
  // arrives here even though the server keeps computing + persisting.
  // Refreshing on switch catches that case so a now-persisted-but-not-
  // yet-shown session appears in the drawer without a page reload.
  // Coalesced: replaySessionMessages may be invoked multiple times in
  // rapid succession (cache-cb + server-cb in resume()), and each
  // independently-rendered drawer is wasted work + visible flicker.
  sessionDrawer.scheduleRefresh();
  // Persist the session id into the chat snapshot so a page reload can
  // re-seed the drawer highlight to this session even though adapter
  // state (conversationName) resets to default on reload.
  chat.trackViewedSession(id);
  viewedSessionForLoadEarlier = id;
  const label = getAgentLabelRef();
  // Batch-render: skip per-line autoScroll + persist (O(N²) without
  // batching). One flush at end does the same work O(N).
  const tRender0 = performance.now();
  for (const m of messages) {
    renderHistoryMessage(m, label, 'append', /*batch*/ true);
  }
  const tFlush0 = performance.now();
  chat.flushBatchedRender();
  const tEnd = performance.now();
  log(
    `[chat-resume] rendered ${messages.length} msgs ` +
    `loop=${Math.round(tFlush0 - tRender0)}ms ` +
    `flush=${Math.round(tEnd - tFlush0)}ms ` +
    `total=${Math.round(tEnd - tRender0)}ms`,
  );

  // Divergence-detection self-heal. After a server-driven replay,
  // the on-screen bubble count should match the server's message
  // set (modulo system_meta rows the server hides + filtered-out
  // CONTEXT-COMPACTION lines we silently drop in renderHistoryMessage).
  // If the count is materially higher, an earlier render path leaked
  // stale bubbles — most commonly the sidekick_id ↔ integer-id dedup-
  // mismatch this code is designed to prevent. Clear and re-render
  // once to recover. The check is O(1) on the happy path (DOM length
  // count + comparison); the heal path is a fresh batch render of
  // up to 200 messages (~10ms). Fires at most once per replaySession-
  // Messages call so we don't loop on stuck divergence.
  const transcriptEl = document.getElementById('transcript');
  if (transcriptEl) {
    // Only count SERVER-BACKED bubbles (finalized, non-pending,
    // non-failed, non-streaming). Optimistic in-flight bubbles
    // (.pending, .failed for a send the user is about to retry,
    // .streaming for a delta that hasn't finalized) are LOCAL-ONLY
    // state and shouldn't trigger the divergence wipe — otherwise a
    // reconcileActiveChat refetch immediately after a failed send
    // wipes the .failed bubble + Retry button before the user can
    // see them (smoke atomic-bubble-pending-failed.mjs).
    const renderedCount = transcriptEl.querySelectorAll(
      '.line[data-message-id]:not(.pending):not(.failed):not(.streaming)',
    ).length;
    // Server count excludes system_meta rows (no content, dropped by
    // renderHistoryMessage). Filter to match.
    const serverContentCount = messages.filter((m: any) => {
      const t = (m?.content || '').trim();
      return t && !t.startsWith('[CONTEXT COMPACTION');
    }).length;
    // Tolerance of +1 covers an in-flight streaming bubble that the
    // server hasn't persisted yet (rare during replay, but possible
    // on tightly-timed reconnects). Higher delta = real divergence.
    if (renderedCount > serverContentCount + 1) {
      log(
        `[chat-resume] divergence detected: DOM has ${renderedCount} ` +
        `bubbles vs server ${serverContentCount} — clearing + re-rendering`,
      );
      renderedMessages.clear();
      activityRow.clearAll();
      replyNavigator.reset();
      // Re-render from server. Don't recurse — we've already cleared
      // the entries map so the upserts here are guaranteed to create.
      for (const m of messages) {
        renderHistoryMessage(m, label, 'append', /*batch*/ true);
      }
      chat.flushBatchedRender();
      log(`[chat-resume] divergence healed: re-rendered ${messages.length} msgs from server`);
    }
  }
  // Register pagination state AFTER messages land so the scroll listener
  // doesn't fire mid-render. hasMore=false (or missing) disables lazy-load.
  chat.setPaginationState(pagination?.firstId ?? null, !!pagination?.hasMore);
  // If the resume was driven by a message-search hit, find the matching
  // bubble and scroll it into view + flash. Best-effort: if the hit
  // predates the initial replay window (older than the first ~200
  // messages), the bubble isn't in the DOM and we fall back to the
  // standard scroll-to-bottom. Drill-to-message via load-earlier is
  // a separate backlog item — see backlog.md.
  if (targetMessageId) {
    const transcriptEl = document.getElementById('transcript');
    const target = transcriptEl?.querySelector(
      `.line[data-message-id="${CSS.escape(targetMessageId)}"]`,
    ) as HTMLElement | null;
    if (target) {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      target.classList.add('search-target-flash');
      setTimeout(() => target.classList.remove('search-target-flash'), 1500);
      return;
    }
    // Fallthrough to scroll-to-bottom if not found — don't leave the
    // user stranded on a random scroll position. A future backlog
    // item drives load-earlier until the target is located.
    log(`[cmdk] target message ${targetMessageId} not in initial replay; load-earlier drill not yet implemented`);
  }
  // Replay any inflight envelopes from the proxy's in-memory cache —
  // user message + tool calls + reply deltas for an in-flight turn
  // that hermes-core hasn't yet persisted to state.db. Replay happens
  // AFTER the state.db render+clear+divergence-heal so the just-
  // rendered state.db bubbles aren't wiped by the clear path. Each
  // envelope goes through the same handler the live SSE stream uses
  // (handleReplyDelta / handleUserMessage / activityRow.appendToolCall
  // etc.) — keyed by stable id so live SSE arrival during this window
  // collapses to the same bubble idempotently. See
  // proxy/sidekick/inflight.ts for the server-side lifecycle.
  if (inflight && inflight.length > 0) {
    log(`[chat-resume] replaying ${inflight.length} inflight envelope(s)`);
    backend.replayInflight?.(id, inflight);
  }
  chat.forceScrollToBottom();
}

/** Shared rendering for both initial replay (append) and load-earlier
 *  (prepend, batched). The caller owns scroll behavior + persist. */
export function renderHistoryMessage(
  m: any,
  label: string,
  mode: 'append' | 'prepend' = 'append',
  batch: boolean = false,
): void {
  const raw = (m.content || '').trim();
  const text = raw;
  if (!text) return;
  // Hermes state.db stores timestamp as float UNIX seconds. chat.addLine's
  // formatTime passes through new Date(ts) which expects milliseconds, so
  // without the *1000 it'd render 1970. If ts is already >= 1e12 it's
  // probably ms already (openclaw / openai-compat backends), so pass
  // through unchanged.
  const rawTs = m.timestamp || m.created_at || m.at;
  const ts = typeof rawTs === 'number' && rawTs < 1e12 ? rawTs * 1000 : rawTs;
  const prepend = mode === 'prepend';
  // Stamp data-message-id on history-rendered bubbles so a subsequent
  // SSE re-delivery for the same message can be deduped at the handler
  // level (see handleReplyDelta / handleReplyFinal).
  //
  // Key selection: prefer `sidekick_id` (the SSE-shape id the plugin
  // emitted live via user_message / reply_final) over the raw integer
  // `id` from state.db. Without this preference the IDB-cached bubble
  // (keyed by umsg_*/msg_*) won't match the history-replay upsert
  // (keyed by integer), causing every reload to duplicate the entire
  // transcript. See backends/hermes/plugin's _write_msg_links_after_turn
  // for the link table the plugin populates after each turn. Falls
  // back to integer id for legacy rows persisted before the link table
  // existed and for messages from other channels (telegram, slack, ...).
  const messageId = m.sidekick_id
    ? String(m.sidekick_id)
    : (m.id != null ? String(m.id) : undefined);
  // Caller may force batching even for append (resume-loop case);
  // prepend always batches because chat.prependHistory wraps the loop.
  const useBatch = prepend || batch;
  if (m.role === 'assistant') {
    if (NO_REPLY_RE.test(text)) return;
    if (messageId) {
      renderedMessages.upsert(messageId, {
        role: 'assistant',
        text,
        status: 'finalized',
        speaker: label,
        cls: 'agent',
        markdown: true,
        timestamp: ts,
        prepend,
        batch: useBatch,
        // replyNavigator (BT skip-fwd / skip-back, per-bubble play
        // chips) keys off data-reply-id. For history-rendered bubbles
        // there's no separate replyId from the live SSE path, so reuse
        // messageId — same stable identifier, same dedup semantics.
        replyId: messageId,
      });
    } else {
      chat.addLine(label, text, 'agent', {
        markdown: true, timestamp: ts, prepend, batch: useBatch,
      });
    }
  } else if (m.role === 'user') {
    if (messageId) {
      renderedMessages.upsert(messageId, {
        role: 'user',
        text,
        status: 'finalized',
        speaker: 'You',
        cls: 's0',
        timestamp: ts,
        prepend,
        batch: useBatch,
      });
    } else {
      chat.addLine('You', text, 's0', {
        timestamp: ts, prepend, batch: useBatch,
      });
    }
  }
  // Tool role / system role: skip for now; UI has no slot for them.
}

/** Scroll-to-top lazy-load. Fetches messages older than `beforeId`
 *  via backend.loadEarlier and prepends them above the existing
 *  transcript. No-op if no chat is currently being viewed. */
export async function loadEarlierHistory(beforeId: number): Promise<void> {
  const id = viewedSessionForLoadEarlier;
  if (!id) return;
  const result: any = await backend.loadEarlier(id, beforeId);
  const older = result.messages || [];
  if (!older.length) {
    chat.setPaginationState(null, false);
    return;
  }
  const label = getAgentLabelRef();
  chat.prependHistory(() => {
    // Iterate oldest→newest. Each prepend inserts at firstChild, so the
    // LAST call ends up topmost — which is what we want since older
    // messages should sit above newer ones that were already on screen.
    // (The returned `messages` array is chronological oldest→newest.)
    for (let i = older.length - 1; i >= 0; i--) {
      renderHistoryMessage(older[i], label, 'prepend');
    }
  });
  chat.setPaginationState(result.firstId ?? null, !!result.hasMore);
}
