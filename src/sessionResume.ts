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
import * as replyNavigator from './audio/turn-based/replyNavigator.ts';
import * as sessionDrawer from './sessionDrawer.ts';
import * as backend from './backend.ts';
import * as transcriptStore from './transcript/store.ts';
import { rerenderActive } from './transcript/index.ts';
import { getScrollPosition, suppressSavesFor } from './chatScrollPositions.ts';

/** Pattern for assistant replies the plugin signals as "no reply" (the
 *  agent chose to stay silent). We drop them from the rendered
 *  transcript rather than show an empty bubble. Exported because the
 *  live SSE handlers in main.ts apply the same filter on reply_delta /
 *  reply_final before upserting. */
export const NO_REPLY_RE = /^\s*NO[-_]?(?:REPL(?:Y)?)?\.?\s*$/i;

let setComposerReadOnlyRef: (readOnly: boolean, source?: string) => void = () => {};
let setHistoryLoadedRef: () => void = () => {};

/** Session id the chat is currently viewing — used by the load-earlier
 *  callback so it knows which session to fetch older messages for.
 *  Updated by replaySessionMessages. */
let viewedSessionForLoadEarlier: string | null = null;

/** Wire the module's callbacks into main.ts. Called once at boot. */
export function initSessionResume(opts: {
  setComposerReadOnly: (readOnly: boolean, source?: string) => void;
  setHistoryLoaded: () => void;
}): void {
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
    `[chat-resume] enter chat_id=${id} viewed=${viewed ?? ''} ` +
    `sameSession=${sameSession} msgCount=${messages.length} ` +
    `inflightCount=${inflight?.length ?? 0} ` +
    `targetMessageId=${targetMessageId ?? ''} ` +
    `firstId=${pagination?.firstId ?? ''} hasMore=${pagination?.hasMore ?? ''}`,
  );
  if (!sameSession) {
    // Per-reply playback pointer — drop the previous chat's state so
    // a stale `.replaying` highlight doesn't survive the switch.
    replyNavigator.reset();
  }
  setHistoryLoadedRef();

  // Read the saved position BEFORE changing viewedSessionId / mutating
  // the transcript. Rendering the new chat can synchronously fire
  // scroll events while the DOM is at a transient top/empty state; if
  // viewedSessionId has already been stamped, those events can overwrite
  // the position we are about to restore. Suppress saves across the
  // whole replay/restore window, not just after render.
  const saved = !targetMessageId ? getScrollPosition(id) : null;
  if (!targetMessageId) suppressSavesFor(1000);

  // setViewed must run BEFORE the store mutates so the reconciler
  // subscription sees the new active chat. The reconciler skips
  // re-renders for non-active chats; we'd lose this render otherwise.
  sessionDrawer.setViewed(id);

  // Composer read-only when viewing a non-sidekick chat.
  const source = sessionDrawer.getSourceForChat(id);
  setComposerReadOnlyRef(source !== 'sidekick', source);

  sessionDrawer.scheduleRefresh();
  chat.trackViewedSession(id);
  viewedSessionForLoadEarlier = id;

  // Drive the store: durable rows + inflight envelopes. Projection +
  // reconciler bring the DOM into agreement. NO clear/iterate loop —
  // the reconciler walks both old and new keys, updates in place,
  // removes orphans. NO divergence-heal — the store IS the source.
  transcriptStore.setDurable(id, messages, {
    firstId: pagination?.firstId ?? null,
    hasMore: !!pagination?.hasMore,
  });
  transcriptStore.setInflight(id, Array.isArray(inflight) ? inflight : []);

  // Force a render — setViewed may have flipped during a notify pass
  // and the subscriber's last call landed on the old chat. rerenderActive
  // is idempotent.
  rerenderActive();

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
      `[data-key="${CSS.escape(targetMessageId)}"]`,
    ) as HTMLElement | null;
    if (target) {
      chat.suppressLoadEarlierFor(1200);
      drillScrollTo(target);
      setTimeout(() => target.classList.remove('search-target-flash'), 1500);
      return;
    }
    // Target ISN'T in the initial replay window — drive load-earlier
    // pages until we find it or run out. Async / fire-and-forget.
    log(`[cmdk] target ${targetMessageId} not in initial window — driving load-earlier drill`);
    void drillToOlderMessage(id, targetMessageId, pagination?.firstId ?? null, !!pagination?.hasMore);
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
  if (saved && !targetMessageId) {
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
      // Mid-chat restoration: prefer a stable DOM anchor over raw
      // scrollTop. Tool rows, markdown blocks, and images can remeasure
      // above the viewport between switch-away and switch-back; anchoring
      // keeps the first visible row at the same visual offset.
      const transcriptEl2 = document.getElementById("transcript");
      if (transcriptEl2) {
        const doRestore = (phase: string) => {
          if (!transcriptEl2) return;
          const before = transcriptEl2.scrollTop;
          const sh = transcriptEl2.scrollHeight;
          const ch = transcriptEl2.clientHeight;
          let wanted = saved.scrollTop;
          if (saved.anchorKey) {
            const anchor = transcriptEl2.querySelector(
              `[data-key="${CSS.escape(saved.anchorKey)}"]`,
            ) as HTMLElement | null;
            if (anchor) {
              const tr = transcriptEl2.getBoundingClientRect();
              const ar = anchor.getBoundingClientRect();
              wanted = transcriptEl2.scrollTop + (ar.top - tr.top) - (saved.anchorOffset ?? 0);
            }
          }
          transcriptEl2.scrollTo({ top: wanted, behavior: "instant" as ScrollBehavior });
          const after = transcriptEl2.scrollTop;
          log(`[chat-resume] restore (${phase}) wanted=${wanted} saved=${saved.scrollTop} anchor=${saved.anchorKey || ""} before=${before} after=${after} sh=${sh} ch=${ch} maxTop=${sh - ch}`);
        };
        doRestore("sync");
        requestAnimationFrame(() => doRestore("rAF"));
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

// Crack A: renderHistoryMessage and its anchor helpers are GONE.
// The projection + reconciler own per-row rendering from the canonical
// ChatState. inflightSignalsMidTurn / bubbleIdFor / findReplayAnchor
// / isNotificationItem all deleted alongside.

/** Scroll the target bubble's TOP to the top of the transcript
 *  viewport — bypassing CSS `scroll-behavior: smooth` set on
 *  `.transcript`. Direct `scrollTop` assignment is universally
 *  instant; `scrollIntoView({behavior:'instant'})` is NOT honored on
 *  iOS WKWebView (Safari treats `'instant'` as `'auto'` which defers
 *  to the CSS smooth, so the animation runs — racing layout shifts
 *  and load-earlier triggers along the way). Field bug 2026-05-13
 *  (Jonathan, iOS): "clicking pins in iOS still doesn't immediately
 *  jump to correct message" — the cycle smoke proved the logic
 *  correct on chromium-emulated mobile, but real iOS still drifted
 *  because the smooth animation kept running.
 *
 *  Compute target scrollTop from current rects so prior layout shifts
 *  (load-earlier prepends, etc.) don't matter. Then re-fire on rAF
 *  to catch any post-paint shifts (image decode, tool-call expansion). */
function drillScrollTo(target: HTMLElement): void {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;
  const apply = () => {
    const tr = transcriptEl.getBoundingClientRect();
    const tg = target.getBoundingClientRect();
    // Desired scrollTop: bring target's top to transcript's top (with
    // an 8px slack so the bubble has visual breathing room from the
    // viewport edge). CSS `scroll-behavior: smooth` on .transcript
    // applies to programmatic scrolls too (including direct scrollTop
    // assignment), which racing the smooth animation against layout
    // shifts produces the iOS "lands wrong" symptom. Override inline,
    // assign, restore — the change is observable only within this
    // microtask, no flicker.
    const prevBehavior = transcriptEl.style.scrollBehavior;
    transcriptEl.style.scrollBehavior = 'auto';
    const desired = transcriptEl.scrollTop + (tg.top - tr.top) - 8;
    transcriptEl.scrollTop = Math.max(0, desired);
    transcriptEl.style.scrollBehavior = prevBehavior;
  };
  target.classList.add('search-target-flash');
  apply();
  requestAnimationFrame(apply);
  // One more retry after a paint+layout cycle catches late-rendering
  // content (images decoding, tool-call summaries hydrating).
  setTimeout(apply, 120);
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
    if (sessionDrawer.getViewed() !== chatId) {
      log(`[cmdk] drill aborted — session changed mid-fetch`);
      return;
    }
    try {
      const result: any = await backend.loadEarlier(chatId, cursor);
      const older = result.messages || [];
      if (!older.length) { hasMore = false; break; }
      // Prepend into the store — projection orders by timestamp; the
      // reconciler walks the spec list and DOM-positions the new
      // bubbles above the existing ones. Wrap in chat.prependHistory
      // so scrollTop is held to the pre-prepend logical position
      // (otherwise drilling lurches the viewport upward at each page).
      chat.prependHistory(() => {
        transcriptStore.prependDurable(chatId, older, {
          firstId: result.firstId ?? null,
          hasMore: !!result.hasMore,
        });
      });
      cursor = result.firstId ?? null;
      hasMore = !!result.hasMore;
      chat.setPaginationState(cursor, hasMore);
    } catch (e: any) {
      diag(`[cmdk] drill page ${i + 1} fetch failed: ${e?.message || e}`);
      return;
    }
    const target = transcriptEl.querySelector(
      `[data-key="${CSS.escape(targetMessageId)}"]`,
    ) as HTMLElement | null;
    if (target) {
      log(`[cmdk] drill found ${targetMessageId} after ${i + 1} page(s)`);
      chat.suppressLoadEarlierFor(1200);
      drillScrollTo(target);
      setTimeout(() => target.classList.remove('search-target-flash'), 1500);
      return;
    }
  }
  log(`[cmdk] drill exhausted — target ${targetMessageId} not found within ${DRILL_PAGE_CAP} pages`);
}

/** Scroll-to-top lazy-load. Fetches messages older than `beforeId`
 *  via backend.loadEarlier and prepends them into the store. No-op
 *  if no chat is currently being viewed.
 *
 *  Scroll preservation: wrap the store mutation in `chat.prependHistory`
 *  so the transcript's scrollTop is adjusted by exactly the amount of
 *  new content inserted above the user's viewport. Without this, the
 *  same logical message they were looking at appears to JUMP upward
 *  by `newScrollHeight - oldScrollHeight` pixels — the field-bug
 *  Jonathan hits when scrolling through long chats on mobile (2026-05-18,
 *  Crack A regression from the legacy chat.prependHistory wrapper). */
export async function loadEarlierHistory(beforeId: number): Promise<void> {
  const id = viewedSessionForLoadEarlier;
  if (!id) return;
  const result: any = await backend.loadEarlier(id, beforeId);
  const older = result.messages || [];
  if (!older.length) {
    chat.setPaginationState(null, false);
    return;
  }
  // Store mutation fires the reconciler subscriber synchronously, so by
  // the time the renderFn returns the new bubbles are in the DOM and
  // prependHistory's scrollHeight delta is accurate.
  chat.prependHistory(() => {
    transcriptStore.prependDurable(id, older, {
      firstId: result.firstId ?? null,
      hasMore: !!result.hasMore,
    });
  });
  chat.setPaginationState(result.firstId ?? null, !!result.hasMore);
}
