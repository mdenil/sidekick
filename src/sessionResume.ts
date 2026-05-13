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
import { showThinking } from './streamingIndicator.ts';
import { getScrollPosition, suppressSavesFor } from './chatScrollPositions.ts';

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
  // every finalized DOM bubble should correspond to either a server
  // message OR an inflight envelope. Anything else is stale state
  // leaked from a prior render path.
  //
  // Structural identity check (replaces the earlier count-tolerance
  // heuristic, which Jonathan correctly called "a hack" — 2026-05-12):
  // build the set of legitimate msgIds, walk DOM, surgically remove
  // bubbles that don't belong. Three classes:
  //
  //   1. STALE: data-message-id matches neither a server message nor
  //      an inflight envelope. Leaked from a previous session's render
  //      or a no-longer-existing message.
  //
  //   2. DEDUP-MISMATCH (the historical 2x-bubble class): a server row
  //      surfaces under BOTH `sidekick_id` AND integer `id`. The
  //      canonical key is sidekick_id when present (see renderHistoryMessage
  //      key selection), so a separately-keyed integer-id bubble for
  //      the same row is the duplicate. Remove the integer-keyed one.
  //
  //   3. ORPHAN: two finalized bubbles share the same data-message-id.
  //      One is in renderedMessages.entries; the other is unreferenced
  //      DOM. Drop the orphan.
  //
  // Optimistic in-flight bubbles (.pending / .failed / .streaming) are
  // LOCAL-ONLY state and excluded from the scan — otherwise a refetch
  // right after a failed send wipes the .failed bubble + Retry button
  // before the user can see them (smoke atomic-bubble-pending-failed).
  const transcriptEl = document.getElementById('transcript');
  if (transcriptEl) {
    const expectedIds = new Set<string>();
    const nonCanonicalIntIds = new Set<string>();
    for (const m of messages) {
      const text = (m?.content || '').trim();
      if (!text || text.startsWith('[CONTEXT COMPACTION')) continue;
      const sid = m?.sidekick_id ? String(m.sidekick_id) : null;
      const iid = m?.id != null ? String(m.id) : null;
      if (sid) {
        expectedIds.add(sid);
        // Only treat the integer id as "non-canonical" when it's actually
        // a DIFFERENT value than sidekick_id — that's the dedup-mismatch
        // signature. If both fields hold the same value (some mocks +
        // some live paths echo the sidekick_id back as `id`), there's
        // no mismatch possible: every renderer keys on the same string.
        if (iid && iid !== sid) nonCanonicalIntIds.add(iid);
      } else if (iid) {
        expectedIds.add(iid);
      }
    }
    if (inflight) {
      for (const env of inflight) {
        if (env?.message_id) expectedIds.add(String(env.message_id));
      }
    }

    // Heal scope: pinned bubbles are STALE-immune (pins are local
    // retention signal that can outlive the server's resume window —
    // see Jonathan dev-log 2026-05-13 line 89 where heal ate a pinned
    // bubble after dev-reload), but they MUST still participate in
    // orphan-dedup. If we exclude .pinned entirely from `finalized`,
    // multiple copies of the same pinned message all skip the
    // seen-id check, and reload produces visible duplicates — field
    // bug Jonathan reported in the same session ("getting dupes on
    // reload now"). So: include them in the candidate set; gate only
    // the stale-removal step by `!el.classList.contains('pinned')`.
    const finalized = Array.from(transcriptEl.querySelectorAll(
      '.line[data-message-id]:not(.pending):not(.failed):not(.streaming)',
    )) as HTMLElement[];
    const seen = new Set<string>();
    const stale: Array<{ id: string; el: HTMLElement }> = [];
    const orphans: HTMLElement[] = [];
    for (const el of finalized) {
      const id = el.dataset.messageId || '';
      if (!id) continue;
      if (seen.has(id)) {
        orphans.push(el);
        continue;
      }
      seen.add(id);
      if (el.classList.contains('pinned')) continue;   // stale-immune
      if (nonCanonicalIntIds.has(id) || !expectedIds.has(id)) {
        stale.push({ id, el });
      }
    }
    if (stale.length || orphans.length) {
      log(
        `[chat-resume] divergence detected: surgical heal — ${stale.length} stale + ` +
        `${orphans.length} orphan bubble(s) (server=${messages.length} ` +
        `inflight=${inflight?.length || 0})`,
      );
      // Cleanup pairs: map entry (if tracked) + DOM node. renderedMessages.remove
      // is a no-op when the id isn't in the map (e.g. a bubble injected directly
      // into DOM by a buggy path — still need the DOM cleanup).
      for (const { id, el } of stale) {
        renderedMessages.remove(id);
        if (el.isConnected) el.remove();
      }
      for (const el of orphans) el.remove();
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
      // Suppress lazy-load while the drill is in flight. The drill
      // scrolls the target near the TOP of the viewport (block:'start'),
      // which crosses the LOAD_EARLIER_THRESHOLD; without this guard
      // every drill triggers a load-earlier page, prepends ~50 older
      // bubbles, and the target shifts to a higher y-coordinate. With
      // a *smooth* scroll the animation kept going to the OLD target y,
      // landing the user on an "earlier" message — the field bug
      // Jonathan reported 2026-05-13 ("takes 3 clicks"). The fix has
      // three layers, all needed:
      //
      //   1) suppressLoadEarlierFor() — pause pagination across the
      //      drill so prepends can't happen.
      //   2) behavior:'instant' — deterministic jump, no animation
      //      window for other scroll listeners to race against.
      //   3) rAF re-scroll — catch layout shifts from late-rendering
      //      content (images, tool-call summaries) that nudge the
      //      target's y after the initial scroll.
      chat.suppressLoadEarlierFor(1200);
      target.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
      target.classList.add('search-target-flash');
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
      });
      setTimeout(() => target.classList.remove('search-target-flash'), 1500);
      return;
    }
    // Target ISN'T in the initial replay window — drive load-earlier
    // until we either find it or run out of history. Field bug
    // 2026-05-13 (Jonathan, dev-log line 353: `[cmdk] target message
    // msg_0f882d80f3c8e498e1a8 not in initial replay; load-earlier
    // drill not yet implemented` — pinning an older message and
    // clicking jump landed on the wrong spot because the bubble
    // wasn't rendered yet).
    //
    // Strategy: page through older history (~50 msgs/page) up to a
    // safety cap (10 pages = ~500 msgs back). Each page prepends to
    // the transcript via the same path scroll-to-top lazy-load uses.
    // suppressLoadEarlierFor blocks the scroll listener from racing.
    //
    // Async / fire-and-forget: the outer replaySessionMessages
    // returns synchronously; the drill runs in the background and
    // scrolls the target into view when found. The pin drawer's
    // closeOnDrillMobile UX still triggers correctly because the
    // drill click already drove that side-effect.
    log(`[cmdk] target ${targetMessageId} not in initial window — driving load-earlier drill`);
    void drillToOlderMessage(id, targetMessageId, pagination?.firstId ?? null, !!pagination?.hasMore);
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
  // Mid-flight restoration: if the inflight set says the agent's turn
  // is still in progress (a user_message envelope exists but no matching
  // reply_final has fired), re-show the thinking indicator so the user
  // knows the turn is still pending. showThinking() is a no-op when a
  // streaming bubble already exists (replayInflight would have created
  // one if reply_delta envelopes were in the set). Without this, an
  // early-window switch — user sends, switches away before the agent
  // emits ANY reply envelopes, then switches back — drops the in-flight
  // indicator entirely; user sees their own message + silence and
  // assumes the agent hung. Pinned by
  // scripts/smoke/inflight-thinking-survives-switch.mjs.
  if (inflight && inflightSignalsMidTurn(inflight)) {
    showThinking();
  }
  // Restore scroll: saved position → land where the user left off;
  // cache miss → scroll to bottom. cmdk message-hit drills
  // (targetMessageId) bypass this path entirely.
  //
  // Two-phase: immediate assignment + rAF retry. The just-cleared-
  // and-repopulated transcript silently ignores scrollTop assignments
  // for one frame on Chromium (also confirmed by autoScroll's parallel
  // failure mode in the same log). Retrying on rAF after the next
  // paint takes the actual scrollTop. suppressSavesFor() also blocks
  // the post-render scroll event from clobbering the saved value with
  // scrollTop=0.
  const saved = getScrollPosition(id);
  if (saved && !targetMessageId) {
    suppressSavesFor(800);
    if (saved.atBottom) {
      // At-bottom restoration: forceScrollToBottom + watch for async
      // DOM-enhancement-driven scrollHeight growth (play-bars, copy
      // buttons, etc.) for a brief window after restore. ResizeObserver
      // re-snaps to the new bottom each time scrollHeight grows, until
      // the window closes or the user manually scrolls up. Without
      // this, a chat whose scrollHeight grows ~2200px post-render
      // (smoke: 5276 → 7514) leaves the user at the OLD bottom = NEW
      // mid-chat. Pinned by smoke
      // scripts/smoke/scroll-position-persists-on-switch.mjs.
      log(`[chat-resume] restore atBottom → forceScrollToBottom + repin`);
      chat.forceScrollToBottom();
      scheduleAtBottomRepin();
    } else {
      // Mid-chat restoration: scrollTo({behavior:'instant'}) bypasses
      // CSS scroll-behavior: smooth so the assignment is immediate.
      const transcriptEl2 = document.getElementById('transcript');
      if (transcriptEl2) {
        const doRestore = (phase: string) => {
          if (!transcriptEl2) return;
          const before = transcriptEl2.scrollTop;
          const sh = transcriptEl2.scrollHeight;
          const ch = transcriptEl2.clientHeight;
          transcriptEl2.scrollTo({ top: saved.scrollTop, behavior: 'instant' as ScrollBehavior });
          const after = transcriptEl2.scrollTop;
          log(`[chat-resume] restore (${phase}) wanted=${saved.scrollTop} before=${before} after=${after} sh=${sh} ch=${ch} maxTop=${sh - ch}`);
        };
        doRestore('sync');
        requestAnimationFrame(() => doRestore('rAF'));
      } else {
        log(`[chat-resume] restore: transcriptEl missing`);
      }
    }
  } else if (!targetMessageId) {
    log(`[chat-resume] no saved position for ${id.slice(-12)} → forceScrollToBottom`);
    chat.forceScrollToBottom();
    scheduleAtBottomRepin();
  }
}

/** Re-pin to the bottom of the transcript whenever scrollHeight grows
 *  during a brief window after a forceScrollToBottom restore. Handles
 *  async DOM enhancement (play-bars, copy buttons, etc.) that add
 *  height after the initial render — without this, the user lands at
 *  the (smaller) post-render bottom and drifts mid-chat as content
 *  grows. Disconnects on first user scroll-up so we don't fight an
 *  intentional reading position. 1.5s window covers the common
 *  cases without lingering. */
const REPIN_WINDOW_MS = 1500;
function scheduleAtBottomRepin(): void {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl || typeof ResizeObserver === 'undefined') return;
  let userScrolledUp = false;
  let lastScrollTop = transcriptEl.scrollTop;
  const onUserScroll = () => {
    // The user moved scrollTop UPWARD by more than the autoScroll
    // pin threshold → stop fighting them.
    const sh = transcriptEl.scrollHeight;
    const ch = transcriptEl.clientHeight;
    const distanceFromBottom = sh - transcriptEl.scrollTop - ch;
    if (distanceFromBottom > 100) userScrolledUp = true;
    lastScrollTop = transcriptEl.scrollTop;
  };
  transcriptEl.addEventListener('touchmove', onUserScroll, { passive: true });
  transcriptEl.addEventListener('wheel', onUserScroll, { passive: true });
  const ro = new ResizeObserver(() => {
    if (userScrolledUp) return;
    transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: 'instant' as ScrollBehavior });
  });
  ro.observe(transcriptEl);
  // Also observe direct children — scrollHeight changes when a CHILD
  // grows (e.g. a bubble has a play-bar appended), and the parent's
  // ResizeObserver fires for its own size only, not children's. Watch
  // each child for the same window.
  for (const child of Array.from(transcriptEl.children)) {
    if (child instanceof HTMLElement) ro.observe(child);
  }
  setTimeout(() => {
    ro.disconnect();
    transcriptEl.removeEventListener('touchmove', onUserScroll);
    transcriptEl.removeEventListener('wheel', onUserScroll);
  }, REPIN_WINDOW_MS);
}

/** True if the inflight set indicates the agent's turn is still in
 *  flight: there's at least one user_message envelope and no matching
 *  reply_final. The proxy's inflight cache lingers for 30s after
 *  reply_final (grace window), so a "just-finalized" chat will have
 *  BOTH envelope types — we don't want to re-show thinking in that
 *  window. */
function inflightSignalsMidTurn(envelopes: any[]): boolean {
  let hasUser = false;
  let hasFinal = false;
  for (const env of envelopes) {
    const t = env?.type;
    if (t === 'user_message') hasUser = true;
    else if (t === 'reply_final') hasFinal = true;
  }
  return hasUser && !hasFinal;
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

/** Page through older history pages until the target message renders
 *  in the DOM, then scroll-and-flash it. Driven by the pin-drawer
 *  jump path (and any cmdk hit on a message OLDER than the resume
 *  window). Caps at 10 pages (~500 msgs) so a stale msgId can't drive
 *  an unbounded backfill. Field bug 2026-05-13. */
const DRILL_PAGE_CAP = 10;
async function drillToOlderMessage(
  chatId: string,
  targetMessageId: string,
  initialFirstId: number | null,
  initialHasMore: boolean,
): Promise<void> {
  let cursor = initialFirstId;
  let hasMore = initialHasMore;
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;
  for (let i = 0; i < DRILL_PAGE_CAP && hasMore && cursor != null; i++) {
    // Bail if the user navigated away mid-drill — the chat we're
    // backfilling isn't the one on screen anymore.
    if (sessionDrawer.getViewed() !== chatId) {
      log(`[cmdk] drill aborted — session changed mid-fetch`);
      return;
    }
    try {
      const result: any = await backend.loadEarlier(chatId, cursor);
      const older = result.messages || [];
      if (!older.length) { hasMore = false; break; }
      const label = getAgentLabelRef();
      chat.prependHistory(() => {
        // oldest→newest into prepend(firstChild), so the LAST iteration
        // ends up topmost — matches the existing lazy-load helper.
        for (let j = older.length - 1; j >= 0; j--) {
          renderHistoryMessage(older[j], label, 'prepend');
        }
      });
      cursor = result.firstId ?? null;
      hasMore = !!result.hasMore;
      chat.setPaginationState(cursor, hasMore);
    } catch (e: any) {
      diag(`[cmdk] drill page ${i + 1} fetch failed: ${e?.message || e}`);
      return;
    }
    // Did the just-prepended page include the target?
    const target = transcriptEl.querySelector(
      `.line[data-message-id="${CSS.escape(targetMessageId)}"]`,
    ) as HTMLElement | null;
    if (target) {
      log(`[cmdk] drill found ${targetMessageId} after ${i + 1} page(s)`);
      chat.suppressLoadEarlierFor(1200);
      target.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
      target.classList.add('search-target-flash');
      requestAnimationFrame(() => {
        target.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
      });
      setTimeout(() => target.classList.remove('search-target-flash'), 1500);
      return;
    }
  }
  log(`[cmdk] drill exhausted — target ${targetMessageId} not found within ${DRILL_PAGE_CAP} pages`);
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
