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
import { rerenderActive, getVirtualizer } from './transcript/index.ts';
import { getScrollPosition } from './chatScrollPositions.ts';

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
  // the transcript. Saves run unconditionally on every scroll event
  // (last write wins), so transient renders that fire scroll(0) just
  // get overwritten by the post-restore scroll(saved). No suppression.
  const saved = !targetMessageId ? getScrollPosition(id) : null;

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
  // Only clobber inflight when the caller explicitly passed an array.
  // The cache-render path in sessionDrawer.resume passes undefined so
  // the live inflight envelopes (user_message echo + reply_delta
  // accumulated while a SEPARATE chat was viewed) survive switch-back.
  // Field bug 2026-05-25 (Jonathan, [pitch deck]): typed + agent
  // started replying, switched away, switched back — user bubble +
  // agent reply vanished because the cached resume's setInflight([])
  // wiped them. The full server-fetch re-render normally repopulates,
  // but the cache-match optimization (same durable length → skip
  // re-render + replayInflight) doesn't always re-paint cleanly.
  if (Array.isArray(inflight)) {
    transcriptStore.setInflight(id, inflight);
  }

  // Force a render — setViewed may have flipped during a notify pass
  // and the subscriber's last call landed on the old chat. rerenderActive
  // is idempotent.
  rerenderActive();

  // Switch-then-load: the row-click handler may have added
  // `.transcript-loading` (blanked + spinner) for this switch. rerenderInto
  // clears it once a NON-EMPTY render lands, but an empty chat (0 durable
  // messages, no inflight) would never trip that path and the spinner
  // would spin forever. Clear unconditionally here now that the target
  // chat's content has been applied — this is the definitive "incoming
  // transcript is rendered" signal.
  document.getElementById('transcript')?.classList.remove('transcript-loading');

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
    // Under virtualization, the target spec may be in the store but
    // outside the visible window — scrollToKey expands the window
    // to it; the next rAF has the bubble in DOM. The default path
    // (no virtualizer) falls through to drillToOlderMessage as before.
    const virt = getVirtualizer();
    if (virt) {
      virt.scrollToKey(targetMessageId, { block: 'center' });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const found = document.getElementById('transcript')?.querySelector(
          `[data-key="${CSS.escape(targetMessageId)}"]`,
        ) as HTMLElement | null;
        if (found) {
          chat.suppressLoadEarlierFor(1200);
          found.classList.add('search-target-flash');
          drillScrollTo(found);
          setTimeout(() => found.classList.remove('search-target-flash'), 1500);
        } else {
          log(`[cmdk] target ${targetMessageId} not in store under virt — driving load-earlier drill`);
          void drillToOlderMessage(id, targetMessageId, pagination?.firstId ?? null, !!pagination?.hasMore);
        }
      }));
      return;
    }
    // Target ISN'T in the initial replay window — drive load-earlier
    // pages until we find it or run out. Async / fire-and-forget.
    log(`[cmdk] target ${targetMessageId} not in initial window — driving load-earlier drill`);
    void drillToOlderMessage(id, targetMessageId, pagination?.firstId ?? null, !!pagination?.hasMore);
  }
  // Restore scroll. Three cases:
  //   - cache miss → scroll to bottom (default for new / never-viewed chats).
  //   - saved.atBottom=true → user was at the live edge at save time. Snap
  //     to the current bottom + scheduleAtBottomRepin (handles "new messages
  //     arrived while away" + post-render layout growth).
  //   - saved.atBottom=false → mid-chat. Restore the literal scrollTop
  //     with a single instant scrollTo. NO maxTop heuristic: comparing
  //     saved against the current maxTop falsely fires "at-edge" when the
  //     initial cache render is partial (a 335-message chat painting just
  //     200 → maxTop=6958 even though the chat's true height ends up
  //     12836). Field bug 2026-05-24 (scroll_save_failing2.mov sequel):
  //     [pitch deck] mid-history restored to bottom + repin → drift
  //     5385px as more bubbles + tool rows + images rendered.
  if (saved && !targetMessageId) {
    const el = document.getElementById('transcript');
    if (el) {
      // Phase 3 anchor-restore: when the virtualizer is active AND the
      // saved record carries an anchorKey, try a key-based restore.
      // Falls back to atBottom/scrollTop if the anchor key isn't in
      // current specs (chat was paginated out, message deleted, etc).
      const virt = getVirtualizer();
      // Precedence: saved.atBottom WINS over anchor restore. The
      // anchor key captures whichever spec was first-visible at save
      // time — for an at-bottom view that's some spec roughly one
      // viewport above the live edge. Restoring to that anchor pins
      // the user to that spec, not to the bottom; if new turns arrived
      // (or post-cache lazy content stretches scrollHeight) the user
      // ends up visibly ABOVE the bottom and has to manually scroll
      // back. Field bug 2026-05-25 (Jonathan, [pitch deck]): "scroll
      // away from the bottom of pitch deck and back — it's somewhere
      // higher up." atBottom is the user-intent flag; honor it first.
      const tryAnchor = !saved.atBottom
        && virt && saved.anchorKey && typeof saved.anchorOffsetPx === 'number'
        ? virt.restoreAnchor({ key: saved.anchorKey, offsetPx: saved.anchorOffsetPx })
        : false;
      if (tryAnchor) {
        log(`[chat-resume] restore via anchor key=${saved.anchorKey?.slice(0, 16)} offset=${saved.anchorOffsetPx}`);
        // Sibling chat's at-bottom repin observer would otherwise see
        // the virtualizer's slot re-paint, treat that as "scrollHeight
        // grew, re-snap to bottom," and undo the anchor restore. The
        // existing mid-chat branch (saved.atBottom=false) handles this
        // the same way — repin is per-element ResizeObserver, not
        // per-chat, so any active observer needs cancelling on switch.
        cancelActiveAtBottomRepin?.();
        // We are NOT at the bottom — assert it so a stray autoScroll (or a
        // false-positive isPinned() at the post-clear scrollTop≈0) can't
        // snap us to the live edge while the heavy chat finishes rendering
        // and fight this anchor restore. Field 2026-05-26 (pitch deck).
        chat.setPinnedToBottom(false);
        // NO load-earlier suppress here. The anchor restore lands the
        // user back on the SAME bubble they were viewing, with the SAME
        // viewport offset. Unlike the legacy mid-chat scrollTop restore,
        // we don't need a 1.5s suppress window — the chat IS in a
        // user-meaningful position immediately after restoreAnchor,
        // and any subsequent scroll-to-top is a genuine user gesture
        // that should fire load-earlier. Field bug 2026-05-25 (smoke):
        // load-earlier-history failed because two duplicate resumes
        // both ran the anchor branch (cache-cb + server-cb path), the
        // second suppress blocked the smoke's immediate scrollTop=0.
      } else if (saved.atBottom) {
        log(`[chat-resume] restore at-edge (atBottom=true savedScrollTop=${saved.scrollTop}) → forceScrollToBottom + repin`);
        chat.forceScrollToBottom();
        scheduleAtBottomRepin();
      } else {
        log(`[chat-resume] restore mid-chat saved=${saved.scrollTop}`);
        // Cancel any sibling chat's still-live at-bottom repin
        // observer — it would otherwise scroll us to the live edge
        // as A's content fills the transcript.
        cancelActiveAtBottomRepin?.();
        // Suppress lazy-prepend for a beat. Restoring near scrollTop=0
        // would otherwise trip maybeLoadEarlier (any scrollTop within
        // LOAD_EARLIER_THRESHOLD_PX of 0 fires lazy-load), and
        // prependHistory would shift scrollTop by the height of the
        // prepended content — dragging the user off `saved`.
        chat.suppressLoadEarlierFor(1500);
        chat.setPinnedToBottom(false);
        el.scrollTo({ top: saved.scrollTop, behavior: 'instant' as ScrollBehavior });
        // The scrollTo fires a scroll event synchronously; the listener
        // updates pinnedToBottom from isPinned() against the restored
        // position, so subsequent autoScroll calls during post-render
        // layout settle correctly skip (mid-chat → pinned=false).
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
/** The active scheduleAtBottomRepin's teardown callback. Cancel before
 *  starting a new replay so a fast switch (chat B at-edge → chat A
 *  mid-chat within REPIN_WINDOW_MS) doesn't have B's still-live
 *  ResizeObserver dragging A's scrollTop to the live edge. */
let cancelActiveAtBottomRepin: (() => void) | null = null;
function scheduleAtBottomRepin(): void {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl || typeof ResizeObserver === 'undefined') return;
  // Cancel any previous repin from a sibling chat that hasn't expired yet.
  cancelActiveAtBottomRepin?.();
  let userScrolledUp = false;
  let pendingUserScrollUntil = 0;
  const markUserScrollIntent = () => {
    pendingUserScrollUntil = Date.now() + 800;
    // Once the user starts interacting with the transcript, stop the
    // temporary bottom-repin immediately. Otherwise a ResizeObserver
    // callback can snap back to bottom before the browser dispatches
    // the resulting scroll event.
    userScrolledUp = true;
  };
  const onScroll = () => {
    if (Date.now() > pendingUserScrollUntil) return;
    const sh = transcriptEl.scrollHeight;
    const ch = transcriptEl.clientHeight;
    const distanceFromBottom = sh - transcriptEl.scrollTop - ch;
    // Wheel/touch/pointer fires before the browser applies the scroll.
    // Cancel the temporary repin only once the subsequent scroll event
    // proves the user actually moved away from the live edge.
    if (distanceFromBottom > 100) userScrolledUp = true;
  };
  transcriptEl.addEventListener('touchmove', markUserScrollIntent, { passive: true });
  transcriptEl.addEventListener('wheel', markUserScrollIntent, { passive: true });
  transcriptEl.addEventListener('pointerdown', markUserScrollIntent, { passive: true });
  transcriptEl.addEventListener('scroll', onScroll, { passive: true });
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
  const teardown = () => {
    ro.disconnect();
    transcriptEl.removeEventListener('touchmove', markUserScrollIntent);
    transcriptEl.removeEventListener('wheel', markUserScrollIntent);
    transcriptEl.removeEventListener('pointerdown', markUserScrollIntent);
    transcriptEl.removeEventListener('scroll', onScroll);
    if (cancelActiveAtBottomRepin === teardown) cancelActiveAtBottomRepin = null;
  };
  cancelActiveAtBottomRepin = teardown;
  // Let a session switch cancel this repin at switch START (before the
  // switch-then-load clear collapses scrollHeight and wakes the RO). The
  // closure always cancels whatever the current active repin is.
  chat.registerAtBottomRepinCanceller(() => cancelActiveAtBottomRepin?.());
  setTimeout(teardown, REPIN_WINDOW_MS);
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
  // Cancel any still-live scheduleAtBottomRepin observer. Without
  // this, the RO sees post-drill scrollHeight growth (e.g. from the
  // load-earlier prepend that brought the target into view) and
  // snaps scrollTop back to scrollHeight — the drillScrollTo retries
  // race against repin and the user lands at the wrong position.
  // Field bug 2026-05-25 (pin-drawer-cycle-scrollback · mobile flake).
  cancelActiveAtBottomRepin?.();
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
    // Under virt the prepended messages are in the store but the slot
    // only renders the ~30-spec window near the bottom — querySelector
    // would miss every time. Check the virt spec list directly, then
    // scrollToKey expands the window to the target before we look for
    // the bubble in DOM. The default path keeps the original DOM-only
    // check since all messages are in DOM there.
    const virt = getVirtualizer();
    if (virt) {
      const specs = virt.getSpecs();
      if (specs.some(s => s.key === targetMessageId)) {
        virt.scrollToKey(targetMessageId, { block: 'center' });
        await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        const found = transcriptEl.querySelector(
          `[data-key="${CSS.escape(targetMessageId)}"]`,
        ) as HTMLElement | null;
        if (found) {
          log(`[cmdk] drill found ${targetMessageId} under virt after ${i + 1} page(s)`);
          chat.suppressLoadEarlierFor(1200);
          found.classList.add('search-target-flash');
          drillScrollTo(found);
          setTimeout(() => found.classList.remove('search-target-flash'), 1500);
          return;
        }
      }
      continue;
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
