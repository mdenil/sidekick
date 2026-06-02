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
import * as sessionCache from './sessionCache.ts';
import { rerenderActive, getVirtualizer } from './transcript/index.ts';
import { getScrollPosition } from './chatScrollPositions.ts';

/** Persist the chat's now-grown in-memory transcript back to IDB so a
 *  later resume/drill reads the deeper history from cache instead of
 *  re-crawling the server page by page. Called after each loadEarlier
 *  prepend (scroll-back AND deep-pin drill). Fire-and-forget; the cap
 *  keeps a pathological session from eating disk. This is what makes
 *  deep pins "get faster warm" — without it IDB only ever holds the
 *  newest page. */
function persistGrownTranscript(id: string): void {
  const s = transcriptStore.getState(id);
  // Caching invariant: only persist a run that
  // reaches the live tail. A floating deep `around` window
  // (hasMoreNewer=true) is a disjoint slice from the middle of the
  // session — writing it would clobber the tail-anchored IDB cache with
  // content that doesn't connect to the newest page. Once loadLater
  // walks the window forward to the tail (hasMoreNewer flips false) the
  // run is contiguous-to-tail and safe to persist; it then grows the
  // cache so subsequent warm jumps within it hit IDB.
  if (s.pagination.hasMoreNewer) return;
  const capped = sessionCache.capTranscript(s.durable, s.pagination);
  void sessionCache.putMessagesCache(id, capped.messages, capped.pagination);
}

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
  opts?: { preserveScrollIfLive?: boolean },
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
  // Without this guard, a cached resume's setInflight([]) would wipe
  // in-flight envelopes (user_message echo + reply_delta) accumulated
  // while a separate chat was viewed — the user bubble + agent reply
  // would vanish on switch-back. The full server-fetch re-render
  // normally repopulates, but the cache-match optimization doesn't
  // always re-paint cleanly.
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
    // Bubble data-key is the bare sidekick_id post-v2 (2026-05-29);
    // matches activity-tray's stored messageId 1:1 with no prefix
    // gymnastics. Plain querySelector lookup.
    const target: HTMLElement | null =
      transcriptEl?.querySelector(`[data-key="${CSS.escape(targetMessageId)}"]`) as HTMLElement | null;
    if (target) {
      chat.suppressLazyLoadFor(1200);
      drillScrollTo(target);
      target.classList.add('search-target-flash');
      const flashTarget = target;
      setTimeout(() => flashTarget.classList.remove('search-target-flash'), 1500);
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
          chat.suppressLazyLoadFor(1200);
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
  if (opts?.preserveScrollIfLive && sameSession && !targetMessageId) {
    // BACKGROUND refetch of the chat already on screen — NOT a user
    // navigation. Callers that pass this flag are reconcile paths: the
    // post-reply durable refresh (schedulePostFinalDurableRefresh) and the
    // disconnect reconcile (onResume). The on-screen scroll position is
    // LIVE truth here; re-applying the SAVED anchor/at-edge position fights
    // the user. A post-reply re-resume's anchor-restore can yank the view
    // UP away from the just-arrived reply and fight manual scrolling. Follow
    // the
    // live edge only if still pinned (so a reply the user is watching keeps
    // streaming into view); otherwise leave scroll EXACTLY as-is.
    //
    // This is deliberately NOT the broad `sameSession` gate: boot/reload
    // ALSO re-resumes with sameSession=true (boot setViewed precedes the
    // restoring resume) and legitimately needs to restore saved scroll —
    // those paths don't pass preserveScrollIfLive, so their restore below
    // still runs.
    if (chat.isPinnedToBottom()) chat.forceScrollToBottom();
  } else if (saved && !targetMessageId) {
    const el = document.getElementById('transcript');
    if (el) {
      // Anchor restore: when the saved record carries an anchorKey, put
      // that same bubble back at the same viewport offset via the DOM
      // (every bubble is in the DOM under full-DOM render). Falls back to
      // atBottom/scrollTop if the key isn't present (paginated out /
      // deleted).
      //
      // Precedence: saved.atBottom WINS over anchor restore. The anchor
      // key captures whichever bubble was first-visible at save time —
      // for an at-bottom view that's some row roughly one viewport above
      // the live edge. Restoring to that anchor pins the user to that
      // row, not to the bottom; if new turns arrived the user ends up
      // visibly ABOVE the bottom. atBottom is the user-intent flag;
      // honor it first.
      const tryAnchor = !saved.atBottom
        && saved.anchorKey && typeof saved.anchorOffsetPx === 'number'
        ? chat.restoreDomAnchor({ key: saved.anchorKey, offsetPx: saved.anchorOffsetPx })
        : false;
      if (tryAnchor) {
        log(`[chat-resume] restore via anchor key=${saved.anchorKey?.slice(0, 16)} offset=${saved.anchorOffsetPx}`);
        // We are NOT at the bottom — assert it so a stray autoScroll (or a
        // false-positive isPinned() at the post-clear scrollTop≈0) can't
        // snap us to the live edge while the chat finishes rendering and
        // fight this anchor restore. Field 2026-05-26 (pitch deck).
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
        // Suppress lazy-prepend across the open render: the full-DOM
        // reconcile briefly sits at scrollTop≈0 before forceScrollToBottom
        // lands, which would trip maybeLoadEarlier and fetch+prepend an
        // older page on every open — cascading toward the top of a big
        // chat (the "load everything on open" cost the virtualizer used to
        // hide). The user is at the live edge here; a genuine scroll-to-top
        // after the window expires still loads earlier.
        chat.suppressLazyLoadFor(800);
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
        chat.suppressLazyLoadFor(1500);
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
    // See at-bottom branch: suppress the open-render scrollTop≈0 transient
    // from triggering a load-earlier prepend cascade on a fresh open.
    chat.suppressLazyLoadFor(800);
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
  // Re-pin to the bottom when the transcript (or a child bubble) resizes
  // during the settle window after a restore-to-bottom — BUT only while the
  // user is still pinned to the bottom. `chat.isPinnedToBottom()` is the
  // SINGLE source of truth, updated on EVERY scroll event (wheel, touch,
  // AND programmatic / virtualizer-rerender scrolls), so the instant the
  // user scrolls up off the bottom this re-pin yields — it can no longer
  // fight the user. The old wheel/touch/pointerdown "intent" detection
  // missed programmatic + rerender-driven scrolls and snapped the user back
  // to the bottom (field 2026-05-27: scroll-up didn't stick). Follow-the-
  // tail during streaming is handled by autoScroll() on each append; this
  // RO just covers async height growth (play-bars, late images) post-restore.
  const ro = new ResizeObserver(() => {
    if (!chat.isPinnedToBottom()) return;
    transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: 'instant' as ScrollBehavior });
  });
  ro.observe(transcriptEl);
  // Also observe direct children — scrollHeight changes when a CHILD grows
  // (e.g. a bubble gets a play-bar appended); the parent RO fires for its
  // own size only, not children's.
  for (const child of Array.from(transcriptEl.children)) {
    if (child instanceof HTMLElement) ro.observe(child);
  }
  const teardown = () => {
    ro.disconnect();
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
 *  and load-earlier triggers along the way). Without the rAF re-fire,
 *  iOS pins could drift because the smooth animation kept running past
 *  load-earlier prepends.
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
  // De-pin so autoScroll() in rerenderInto (the follow-tail hook we
  // added with the virtualizer gut) doesn't snap us back to the bottom
  // on the next render — the user explicitly asked to be at THIS
  // bubble, not the live edge. Without this, autoScroll can yank back
  // to scrollHeight on a duplicate-resume render after drillScrollTo.
  chat.setPinnedToBottom(false);
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
  // One bounded around-window fetch first (the 5–20s deep-pin lag fix);
  // fall through to the serial loadEarlier loop only when the target is
  // missing from the around result.
  if (await drillViaAroundWindow(chatId, targetMessageId)) return;
  await drillViaSerialOlderPages(chatId, targetMessageId, initialFirstId, initialHasMore);
}

/** Same-session jump to a message bubble — the chat is ALREADY rendered.
 *  Must NOT route through sessionDrawer.resume(): that re-resumes the
 *  session (cache render + server reconcile, EACH driving its own drill =
 *  redundant ~1MB ?around= round trips that saturate a high-latency link)
 *  AND its in-flight dedup keys only on chat id, so a rapid second jump to
 *  a DIFFERENT target in the same session gets swallowed and the bubble
 *  never appears (one jump can hang forever while the next fires several
 *  concurrent large fetches). Instead: scroll+flash if the bubble is already
 *  in the DOM (instant), else ONE bounded around fetch, else serial
 *  older-page paging. */
export async function drillToMessageInViewedSession(
  chatId: string,
  targetMessageId: string,
): Promise<void> {
  const transcriptEl = document.getElementById('transcript');
  const existing = transcriptEl?.querySelector(
    `[data-key="${CSS.escape(targetMessageId)}"]`,
  ) as HTMLElement | null;
  if (existing) {
    chat.suppressLazyLoadFor(1200);
    existing.classList.add('search-target-flash');
    drillScrollTo(existing);
    setTimeout(() => existing.classList.remove('search-target-flash'), 1500);
    return;
  }
  if (await drillViaAroundWindow(chatId, targetMessageId)) return;
  const s = transcriptStore.getState(chatId);
  await drillViaSerialOlderPages(
    chatId, targetMessageId, s.pagination.firstId, s.pagination.hasMore,
  );
}

/** Single-flight bounded "items around target" drill. Returns true once
 *  the target rendered + scrolled. Keyed by chat+target so the cache-render
 *  and server-render passes of one resume() collapse to a SINGLE ?around=
 *  fetch instead of two concurrent ~1MB round trips. The plugin returns a
 *  window centered on the target (context above + below), capped at ~limit
 *  rows — payload O(limit), independent of how deep the target sits. We
 *  REPLACE the transcript with this floating window and arm BIDIRECTIONAL
 *  pagination: scroll-up walks older via loadEarlierHistory, scroll-down
 *  walks newer via loadLaterHistory back toward the live tail. */
// Keep the initial drill window TIGHT — just enough rows to render the
// target centered with a screenful of scrollback. A row can carry a large
// tool result, so a full 200-row page is ~830KB; over a high-latency link
// that's the bulk of a deep jump's wait over a high-latency link.
// A ~40-row window is ~290KB (~1/3) and still fills the viewport; the user
// pulls more in by scrolling (gated loadEarlier/loadLater).
const DRILL_AROUND_LIMIT = 40;
let aroundDrillInFlight: { key: string; promise: Promise<boolean> } | null = null;
function drillViaAroundWindow(chatId: string, targetMessageId: string): Promise<boolean> {
  const key = `${chatId}::${targetMessageId}`;
  if (aroundDrillInFlight?.key === key) return aroundDrillInFlight.promise;
  const promise = (async (): Promise<boolean> => {
    const transcriptEl = document.getElementById('transcript');
    if (!transcriptEl) return false;
    try {
      const around: any = await backend.fetchMessagesAround(chatId, targetMessageId, DRILL_AROUND_LIMIT);
      if (sessionDrawer.getViewed() !== chatId) {
        log(`[cmdk] drill aborted — session changed during around fetch`);
        return false;
      }
      if (!(around?.targetFound && Array.isArray(around.messages) && around.messages.length)) {
        return false;
      }
      // Arm the lazy-load suppress window BEFORE any render/scroll. The
      // bounded window lands the target mid-transcript, so the render +
      // scrollToKey below can fire a scroll that would otherwise trip
      // maybeLoadEarlier/maybeLoadLater into a wasteful ?before=/?after=
      // page right after the drill. Setting it here (not after the scroll)
      // closes that leak.
      chat.suppressLazyLoadFor(1200);
      // We are jumping into the MIDDLE of the session — not at the live
      // tail. Assert un-pinned BEFORE the render so autoScroll can't snap
      // us to the window's bottom while it settles.
      chat.setPinnedToBottom(false);
      transcriptStore.setDurable(chatId, around.messages, {
        firstId: around.firstId ?? null,
        hasMore: !!around.hasMore,
        lastId: around.lastId ?? null,
        hasMoreNewer: !!around.hasMoreNewer,
      });
      chat.setPaginationState(
        around.firstId ?? null, !!around.hasMore,
        around.lastId ?? null, !!around.hasMoreNewer,
      );
      rerenderActive();
      // Persist is a no-op while the window floats (hasMoreNewer); it
      // only writes once loadLater connects the run to the tail.
      persistGrownTranscript(chatId);
      // Scroll the target into view. Under virt the spec may be outside
      // the rendered window — scrollToKey expands to it first.
      const virt = getVirtualizer();
      if (virt) virt.scrollToKey(targetMessageId, { block: 'center' });
      await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const found = transcriptEl.querySelector(
        `[data-key="${CSS.escape(targetMessageId)}"]`,
      ) as HTMLElement | null;
      if (!found) {
        log(`[cmdk] around window returned but ${targetMessageId} not in DOM — serial fallback`);
        return false;
      }
      log(`[cmdk] drill found ${targetMessageId} via bounded around window (1 round trip)`);
      found.classList.add('search-target-flash');
      drillScrollTo(found);
      setTimeout(() => found.classList.remove('search-target-flash'), 1500);
      return true;
    } catch (e: any) {
      diag(`[cmdk] around-window drill failed: ${e?.message || e} — serial fallback`);
      return false;
    }
  })();
  aroundDrillInFlight = { key, promise };
  return promise.finally(() => {
    if (aroundDrillInFlight?.key === key) aroundDrillInFlight = null;
  });
}

async function drillViaSerialOlderPages(
  chatId: string,
  targetMessageId: string,
  initialFirstId: number | null,
  initialHasMore: boolean,
): Promise<void> {
  const transcriptEl = document.getElementById('transcript');
  if (!transcriptEl) return;
  let cursor = initialFirstId;
  let hasMore = initialHasMore;
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
      persistGrownTranscript(chatId);
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
          chat.suppressLazyLoadFor(1200);
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
      chat.suppressLazyLoadFor(1200);
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
 *  by `newScrollHeight - oldScrollHeight` pixels when new rows are
 *  prepended above the viewport. */
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
  // prependDurable preserves the newer cursor; re-publish BOTH halves so
  // chat's load-later state survives a load-earlier on a floating window.
  const sEarlier = transcriptStore.getState(id);
  chat.setPaginationState(
    result.firstId ?? null, !!result.hasMore,
    sEarlier.pagination.lastId, sEarlier.pagination.hasMoreNewer,
  );
  persistGrownTranscript(id);
}

/** Scroll-to-bottom lazy-load — the symmetric counterpart to
 *  loadEarlierHistory. Fetches messages newer than `afterId` via
 *  backend.loadLater and appends them, walking a floating deep `around`
 *  window forward toward the live tail. When the fetch reaches the tail
 *  (hasMoreNewer=false) the now-contiguous run becomes eligible for IDB
 *  persistence (persistGrownTranscript's guard lifts). No-op if no chat
 *  is currently being viewed. */
export async function loadLaterHistory(afterId: number): Promise<void> {
  const id = viewedSessionForLoadEarlier;
  if (!id) return;
  const result: any = await backend.loadLater(id, afterId);
  const newer = result.messages || [];
  chat.appendHistory(() => {
    transcriptStore.appendDurable(id, newer, {
      lastId: result.lastId ?? null,
      hasMoreNewer: !!result.hasMoreNewer,
    });
  });
  const s = transcriptStore.getState(id);
  chat.setPaginationState(
    s.pagination.firstId, s.pagination.hasMore,
    s.pagination.lastId, s.pagination.hasMoreNewer,
  );
  persistGrownTranscript(id);
}

/** Jump to the live tail from a floating deep window. Re-resumes the
 *  viewed session (fetches the newest page), replaces the floating
 *  window with the tail-anchored transcript, and scrolls to the bottom.
 *  Wired as chat's jump-to-bottom handler while hasMoreNewer is true. */
export async function jumpToLatest(): Promise<void> {
  const id = viewedSessionForLoadEarlier;
  if (!id) { chat.forceScrollToBottom(); return; }
  try {
    const result: any = await backend.resumeSession(id);
    if (sessionDrawer.getViewed() !== id) return;
    transcriptStore.setDurable(id, result.messages || [], {
      firstId: result.firstId ?? null,
      hasMore: !!result.hasMore,
    });
    if (Array.isArray(result.inflight)) transcriptStore.setInflight(id, result.inflight);
    rerenderActive();
    chat.setPaginationState(result.firstId ?? null, !!result.hasMore);
    persistGrownTranscript(id);
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    chat.forceScrollToBottom();
  } catch (e: any) {
    diag(`[jump-to-latest] failed: ${e?.message || e}`);
  }
}
