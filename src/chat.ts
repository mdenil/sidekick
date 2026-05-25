/**
 * @fileoverview Chat transcript — line rendering, speaker labels, copy button.
 */

import { escapeHtml } from './util/dom.ts';
import { miniMarkdown } from './util/markdown.ts';
import { diag, log } from './util/log.ts';
import {
  ensureSchemaFresh,
  loadSnapshot,
  saveSnapshot,
  clearSnapshot,
} from './chatSnapshot.ts';
import {
  hydrateScrollPositions,
  saveScrollPosition,
  flushScrollPosition,
  getScrollPosition,
} from './chatScrollPositions.ts';
import { isPinned as isPinMsg, pinMessage, unpinMessage, hydrate as hydratePins } from './pins/store.ts';
import * as backend from './backend.ts';
import { getVirtualizerSlot, getVirtualizer, rerenderActive } from './transcript/index.ts';
import * as transcriptStore from './transcript/store.ts';

let transcriptEl: HTMLElement | null = null;

/** Where legacy addLine consumers (system delimiter, backfill replay)
 *  should hand their `.line` divs. Under virtualization the content
 *  area is the virtualizer's slot — a sibling of the top/bottom
 *  spacers — not the transcript root. Default falls back to
 *  transcriptEl, which is the production behavior pre-virt. Lazy:
 *  recomputed on every call so a flag flipped after boot picks up. */
function contentTarget(): HTMLElement | null {
  return getVirtualizerSlot() || transcriptEl;
}
let scrollToBottomBtn: HTMLElement | null = null;
const speakerNames: Record<string | number, string> = {};
let speakerCount = 0;

/** In-memory mirror of the session id the current chat view corresponds to.
 *  Set by replaySessionMessages → trackViewedSession(id), cleared on
 *  chat.clear() so a New chat rotation doesn't keep a stale id in the
 *  next persisted snapshot. Stored alongside the HTML on persist so
 *  reload can restore the drawer highlight to the right row. */
let viewedSessionIdRef: string | null = null;

/** Per-msgId fold state. The "Show more / Show less" toggle on long
 *  bubbles needs to survive virt unmount/remount: a bubble scrolled
 *  outside the visible window is destroyed, its expanded class lost.
 *  Map lookup at addLine time restores the user's toggle. Cleared on
 *  chat.clear (New chat rotation) so the keyspace can't grow without
 *  bound. Module-level — same shape as pin store, simple + cheap. */
const foldStateByMsgId = new Map<string, 'expanded' | 'collapsed'>();

/** Let main.ts record which session the chat is currently rendering.
 *  Drawer reads it back after boot via getViewedSessionId() — survives
 *  page reload because we persist it in the chat snapshot. */
export function trackViewedSession(id: string | null) {
  viewedSessionIdRef = id;
  persist();  // update the snapshot so reload picks it up
}

/** Return the session id the restored snapshot belongs to, if any.
 *  Called by main.ts boot to re-seed the drawer highlight after
 *  restoreSnapshot(). */
let restoredViewedSessionId: string | null = null;
export function getRestoredViewedSessionId(): string | null {
  return restoredViewedSessionId;
}

/** Pixels from bottom within which the user is considered "pinned" to the
 *  live edge — new messages auto-scroll. Past this threshold (they've
 *  scrolled up to read earlier content), auto-scroll is suspended and the
 *  jump-to-bottom button appears.
 *
 *  Generous threshold (300px) so user-scroll-to-near-the-edge still
 *  counts as pinned and autoScroll keeps following streaming replies. */
const PINNED_THRESHOLD_PX = 300;

let pinnedToBottom = true;
let missedWhileScrolled = 0;

export function saveCurrentScrollPosition(): void {
  if (!transcriptEl || !viewedSessionIdRef) return;
  // Under virtualization, capture the anchor (key + offset) alongside
  // raw scrollTop. The anchor is DOM-invariant — if heights elsewhere
  // shift after restore (image loads, tool rows expand), the anchored
  // spec stays at the same viewport offset. scrollTop is still saved
  // for the legacy/dual-read path; restore prefers anchor when present.
  const virt = getVirtualizer();
  const anchor = virt ? virt.getAnchor() : null;
  saveScrollPosition(viewedSessionIdRef, transcriptEl.scrollTop, isPinned(), anchor);
}


function isPinned(): boolean {
  if (!transcriptEl) return true;
  const distance = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
  return distance <= PINNED_THRESHOLD_PX;
}

function updateButton(): void {
  if (!scrollToBottomBtn) return;
  scrollToBottomBtn.classList.toggle('visible', !pinnedToBottom);
  scrollToBottomBtn.classList.toggle('has-unread', missedWhileScrolled > 0);
  scrollToBottomBtn.setAttribute('aria-hidden', pinnedToBottom ? 'true' : 'false');
  if (missedWhileScrolled > 0) {
    const badge = scrollToBottomBtn.querySelector('.scroll-to-bottom-badge');
    if (badge) badge.textContent = String(Math.min(missedWhileScrolled, 99));
  }
}

/** Unconditional scroll to the live edge. Used by initial loads,
 *  user-initiated jump-to-bottom, and anywhere we deliberately want to
 *  override the "user scrolled up" state.
 *
 *  Bypasses smooth-scroll via `behavior: 'instant'` because session-resume
 *  triggers multiple cascading scrolls (renderSession, backfillHistory,
 *  snapshot restore, image/code-block reflows) — with `scroll-behavior:
 *  smooth` in CSS each call animates separately and the user sees a stutter.
 *  Streaming deltas still go through autoScroll() which keeps smooth so the
 *  follow-along during reply still glides. */
export function forceScrollToBottom(): void {
  if (!transcriptEl) return;
  const doScroll = () => {
    if (!transcriptEl) return;
    transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: 'instant' as ScrollBehavior });
  };
  // Belt-and-braces: scroll immediately (works in 95% of cases when
  // layout is already up-to-date), AND again on next animation frame
  // (covers the cases where bubbles were just appended and the browser
  // hadn't run layout yet — scrollHeight read returned a stale value
  // that didn't include the new content). Field repro 2026-05-04
  // (Jonathan): switching sessions occasionally left the chat scrolled
  // to top with content below the viewport; manual scroll revealed the
  // bubbles were rendered correctly, just not scrolled to.
  doScroll();
  // iOS PWA fix (Jonathan, 2026-05-05): scrollTop reaches the correct
  // value (verified via [scroll-debug] traces) but iOS doesn't paint —
  // user sees black, and the next touch snaps back. WebKit render bug
  // class. Anchor the scroll on a real DOM child via scrollIntoView so
  // the renderer has a known target to commit to. Last-element seek
  // works on every browser; on iOS it's the difference between paint
  // and not-paint.
  requestAnimationFrame(() => {
    if (!transcriptEl) return;
    doScroll();
    const last = transcriptEl.lastElementChild as HTMLElement | null;
    if (last && typeof last.scrollIntoView === 'function') {
      try { last.scrollIntoView({ block: 'end', inline: 'nearest' }); } catch { /* noop */ }
    }
  });
  pinnedToBottom = true;
  missedWhileScrolled = 0;
  updateButton();
}

/** Scroll to the live edge ONLY if the user is already pinned. If they've
 *  scrolled up to read earlier, leave their position alone and count the
 *  new message toward the unread badge on the jump-to-bottom button.
 *
 *  Tracks the "owner" of the most recent autoScroll burst — when many calls
 *  arrive in quick succession (resume + render + reflow) only the FIRST
 *  animates smoothly; subsequent calls within 200ms snap instantly so the
 *  user doesn't see two animations chained together. Streaming-delta
 *  cadence (one call per ~100ms with steady scrollHeight growth) flows
 *  through the smooth path naturally because each call re-establishes the
 *  burst window from the same call site. */
let _autoScrollBurstUntil = 0;
export function autoScroll(): void {
  if (!transcriptEl) return;
  // Diagnose dictation/streaming auto-scroll regression: log before+after
  // state so we can see whether autoScroll is being CALLED but failing
  // (pinned=false because of a stale flip) vs being called but scrolling
  // to a stale scrollHeight (layout not yet reflowed) vs not being called
  // at all (the streaming render path skips autoScroll). Read both before
  // and after the scroll to catch the stale-scrollHeight case.
  const stBefore = transcriptEl.scrollTop;
  const shBefore = transcriptEl.scrollHeight;
  const ch = transcriptEl.clientHeight;
  if (pinnedToBottom) {
    const now = performance.now();
    const inBurst = now < _autoScrollBurstUntil;
    _autoScrollBurstUntil = now + 200;
    // Both branches use scrollTo(behavior:'instant'). Raw scrollTop
    // assignment honors CSS scroll-behavior:smooth on .transcript and
    // animates over ~300ms — under virt every intermediate scroll
    // event triggers a rerender + spacer height adjustment, which
    // surfaces as a "twitch" during streaming / dictation newlines.
    // The first-of-burst case previously used the smooth path to give
    // a gentle ride on the very first reply_delta of a turn; with virt
    // the rerender cost makes that animation visibly chunky. Instant
    // is cleaner across both paths.
    transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: 'instant' as ScrollBehavior });
    const stAfter = transcriptEl.scrollTop;
    const shAfter = transcriptEl.scrollHeight;
    const tail = shAfter - stAfter - ch;
    diag(`[autoscroll] pinned scrollTop ${stBefore}→${stAfter} scrollHeight ${shBefore}→${shAfter} ch=${ch} tail=${tail} burst=${inBurst}`);
  } else {
    missedWhileScrolled++;
    diag(`[autoscroll] skipped (not pinned) scrollTop=${stBefore} scrollHeight=${shBefore} ch=${ch} missed=${missedWhileScrolled}`);
    updateButton();
  }
}

/** Returns true if a transcript snapshot was restored. Caller may still
 *  run backfill — dedup on text handles overlap. Async because IDB reads
 *  can't be synchronous; the cold-boot flash is sub-frame on modern devices. */
export async function init(el: HTMLElement | null): Promise<boolean> {
  transcriptEl = el;
  // Schema check FIRST — if the on-disk format is stale, nuke IDB
  // before any reader path runs. Avoids racing a delete against a
  // concurrent loadSnapshot. See SCHEMA_VERSION comment for policy.
  await ensureSchemaFresh();
  // Hydrate per-chat scroll positions from IDB into an in-memory
  // cache so sessionResume's first read returns the persisted value.
  // AWAITED (not fire-and-forget) so the first replaySessionMessages
  // after boot doesn't race the IDB read — otherwise the snapshot-
  // restore's forceScrollToBottom would overwrite cache with the
  // bottom of the snapshot before the persisted user-intent value
  // lands. IDB read is fast (~10ms), well under perceptible delay.
  const t0 = performance.now();
  await hydrateScrollPositions();
  diag(`[chat-scroll] hydrate finished ${Math.round(performance.now() - t0)}ms after chat.init`);
  // Hydrate the pinned-messages store so the per-bubble pin button
  // paints with correct state on the first render. Fire-and-forget —
  // server fetch is fast (~50ms on LAN); a bubble rendered before the
  // hydrate resolves just gets a momentary "unpinned" indicator that
  // flips via the sidekick:pins-changed listener once the server-
  // driven cache populates.
  void hydratePins();
  // Flush the pending scroll-position write on page unload so a reload
  // immediately after a scroll (faster than the 200ms IDB debounce)
  // still picks up the latest position on next boot.
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      if (viewedSessionIdRef) flushScrollPosition(viewedSessionIdRef);
    });
  }
  // Repaint all bubble pin indicators when the pin set changes.
  // Fires on: hydrate completion (catches bubbles that rendered
  // before the server fetch resolved), explicit pinMessage /
  // unpinMessage from anywhere, and the cross-device sync path
  // (server-pins-changed via proxyClient). Cheap — walks .pin-btn
  // elements only (most bubbles don't have one — only those with a
  // stable msgId), reads isPinned() synchronously.
  if (typeof window !== 'undefined') {
    window.addEventListener('sidekick:pins-changed', () => {
      if (!transcriptEl || !viewedSessionIdRef) return;
      const chatId = viewedSessionIdRef;
      transcriptEl.querySelectorAll<HTMLElement>('.line[data-message-id]').forEach((line) => {
        const msgId = line.dataset.messageId || '';
        if (!msgId) return;
        const pinned = isPinMsg(chatId, msgId);
        line.classList.toggle('pinned', pinned);
        const btn = line.querySelector<HTMLButtonElement>('.pin-btn');
        if (btn) btn.classList.toggle('pinned', pinned);
      });
    });
  }

  // Jump-to-bottom button wiring. The button lives outside the transcript
  // scroller (as a sibling inside .chat-column) so it stays fixed while
  // the transcript scrolls.
  scrollToBottomBtn = document.getElementById('scroll-to-bottom');
  if (scrollToBottomBtn) {
    scrollToBottomBtn.addEventListener('click', () => forceScrollToBottom());
  }
  if (transcriptEl) {
    transcriptEl.addEventListener('scroll', () => {
      maybeLoadEarlier();
      // Save the current scroll position on every scroll event — both
      // user-driven and JS-driven (autoScroll, restore). Last write
      // wins, which is the actual user-visible position. No user-vs-JS
      // distinction needed: the FINAL scrollTop after all events fire
      // is what should persist.
      if (transcriptEl && viewedSessionIdRef) {
        saveCurrentScrollPosition();
      }
      // Re-evaluate pinned on every scroll. autoScroll's `if (pinned)`
      // guard does the right thing in both directions:
      //   - User scrolls up → distance > threshold → pinned=false →
      //     autoScroll stops following the live edge as content grows.
      //   - User scrolls back to bottom (or autoScroll lands at bottom)
      //     → distance ≤ threshold → pinned=true → autoScroll resumes.
      //   - JS-driven restore sets scrollTop=N → if N is mid-chat →
      //     pinned=false → subsequent bubble adds don't drag the user
      //     away from the restored position.
      const wasPinned = pinnedToBottom;
      pinnedToBottom = isPinned();
      if (pinnedToBottom && !wasPinned) missedWhileScrolled = 0;
      updateButton();
    }, { passive: true });
  }

  try {
    const saved = await loadSnapshot();
    if (saved && transcriptEl && saved.state && saved.sessionId) {
      // Virt-path cold-load: inject the persisted store state and
      // let the projection + reconciler render. The active chat-id is
      // claimed here (so concurrent backfill / boot's most-recent
      // fallback can't double-up) and the scroll position restores
      // from the chat-scroll cache. Server fetch arrives later via
      // backfillHistory / replaySessionMessages and replaces durable
      // wholesale; the snapshot is just the offline-cache bridge.
      restoredViewedSessionId = saved.sessionId;
      viewedSessionIdRef = restoredViewedSessionId;
      transcriptStore.setDurable(
        saved.sessionId,
        saved.state.durable,
        saved.state.pagination,
      );
      // The render itself happens in bindTranscriptPipeline's subscriber
      // (fired by setDurable above) — but that subscriber isn't bound
      // yet at chat.init time. trigger the render here so the cached
      // transcript paints before the server fetch lands. Lazy
      // ensureVirtualizer is fine; the upstream caller resumes from
      // here and the virt slot will already exist when SSE replay /
      // resume fire.
      rerenderActive();
      // Restore the user's last scroll position from the hydrated
      // cache. Cache miss → scroll to bottom.
      const savedRec = getScrollPosition(restoredViewedSessionId);
      if (savedRec?.atBottom) forceScrollToBottom();
      else if (savedRec) transcriptEl.scrollTo({ top: savedRec.scrollTop, behavior: 'instant' as ScrollBehavior });
      else forceScrollToBottom();
      return true;
    }
    if (saved && transcriptEl && saved.html) {
      transcriptEl.innerHTML = saved.html;
      restoredViewedSessionId = saved.sessionId || null;
      viewedSessionIdRef = restoredViewedSessionId;
      // Strip stale memo cards — their audio element + blob reference are dead
      // after serialization. Caller will re-render them fresh from IndexedDB.
      transcriptEl.querySelectorAll('.memo-card').forEach(el => el.remove());
      // Strip stale activity rows. saveSnapshot() (below) excludes them
      // going forward, but existing IDB snapshots written by older builds
      // may still carry them and would dupe with fresh inflight replay.
      // Idempotent: a fresh snapshot has none.
      transcriptEl.querySelectorAll('.activity-row').forEach(el => el.remove());
      // Initial load: restore the user's last scroll position from the
      // hydrated cache (already loaded above). Cache miss → scroll to
      // bottom. Note: forceScrollToBottom is intentionally NOT called
      // unconditionally here — that used to overwrite the persisted
      // user-intent value before sessionResume's restore could read it.
      if (restoredViewedSessionId) {
        const savedRec = getScrollPosition(restoredViewedSessionId);
        if (savedRec) {
          if (savedRec.atBottom) {
            forceScrollToBottom();
          } else {
            transcriptEl.scrollTo({ top: savedRec.scrollTop, behavior: 'instant' as ScrollBehavior });
          }
        } else {
          forceScrollToBottom();
        }
      } else {
        forceScrollToBottom();
      }
      // Re-wire copy buttons on restored elements. Same source-of-truth as
      // the live-create path: prefer dataset.text (raw markdown) over
      // rendered textContent so round-trip copy is lossless.
      transcriptEl.querySelectorAll<HTMLElement>('.copy-btn').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const line = btn.closest<HTMLElement>('.line');
          const text = line?.dataset.text
            || line?.querySelector('.text')?.textContent
            || '';
          navigator.clipboard.writeText(text).catch(() => {});
        };
      });
      // Re-wire show-more/show-less buttons. Snapshot restores the DOM
      // text but the onclick handler is lost across page reload. Without
      // this re-attach, buttons existed visually but did nothing —
      // particularly visible on iOS PWA where reload is the common
      // entry path (Jonathan field bug 2026-05-17).
      transcriptEl.querySelectorAll<HTMLElement>('.bubble-fold-toggle').forEach(btn => {
        const line = btn.closest<HTMLElement>('.line');
        if (!line) return;
        btn.onclick = (e) => {
          e.stopPropagation();
          const expanded = line.classList.toggle('expanded');
          btn.textContent = expanded ? 'Show less' : 'Show more';
        };
      });
      // Reset play-bar state on restored agent bubbles. Audio buffers are
      // in-memory and don't survive reload; serialized bar widths + state
      // classes would give a false "already loaded / already played" look.
      // User clicks play → re-synthesis happens fresh.
      const seenIds = new Set<string>();
      transcriptEl.querySelectorAll<HTMLElement>('.line.agent').forEach(line => {
        line.classList.remove('tts-active', 'tts-streaming', 'tts-playing', 'tts-paused', 'tts-played');
        const loaded = line.querySelector<HTMLElement>('.play-bar-loaded');
        const played = line.querySelector<HTMLElement>('.play-bar-played');
        if (loaded) loaded.style.width = '0%';
        if (played) played.style.width = '0%';
        // Invariant: each agent bubble must have a unique data-reply-id.
        // If a snapshot contains duplicates (from a version that let
        // streamingTtsReplyId leak across replies), re-mint on the
        // duplicates so play-click routing can distinguish them.
        const id = line.dataset.replyId;
        if (!id || seenIds.has(id)) {
          line.dataset.replyId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        }
        seenIds.add(line.dataset.replyId);
      });
      return true;
    }
  } catch {}
  return false;
}

/** Fire-and-forget snapshot write to IndexedDB. Backfill from the gateway
 *  still plugs any gap on next connect (see always-run-backfill branch in
 *  main.ts) in case the IDB write fails mid-flight.
 *
 *  Activity rows (`.activity-row` — the collapsed "N tools · done"
 *  surface) are stripped before serialization. Reason: they have no
 *  `data-message-id` and so are invisible to `renderedMessages.upsert`'s
 *  dedup-by-id path. Persisting them produces a cascading dupe — every
 *  reload restores the prior DOM row AND a fresh replay from inflight
 *  appends another (since the in-memory `rows` Map is empty post-JS-
 *  reset). 3 reloads → 3 stacked "N tools · done" rows on the same chat
 *  (Jonathan field bug 2026-05-17).
 *
 *  Trade-off: past-turn activity rows disappear on reload. Acceptable
 *  for now; the principled fix is to extend renderHistoryMessage to
 *  reconstruct activity rows from state.db's `role='tool'` /
 *  `role='assistant' (tool_calls JSON)` rows. Follow-up. */
function persist(): void {
  if (!transcriptEl) return;
  // Under virtualization, transcriptEl only contains the current
  // visible window + spacers — serializing innerHTML would freeze a
  // partial snapshot that's wrong on reload. Save the transcriptStore's
  // durable + pagination for the active chat instead; cold-load injects
  // it into the store and the projection + reconciler render via the
  // normal pipeline (Decision 4A, 2026-05-25).
  if (getVirtualizerSlot()) {
    if (!viewedSessionIdRef) return;
    const state = transcriptStore.getState(viewedSessionIdRef);
    saveSnapshot(
      { state: { durable: state.durable.slice(), pagination: { ...state.pagination } } },
      viewedSessionIdRef,
    ).catch((e) => diag(`chat.persist failed: ${e?.message || 'idb error'}`));
    return;
  }
  const clone = transcriptEl.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('.activity-row').forEach((el) => el.remove());
  const html = clone.innerHTML;
  saveSnapshot({ html }, viewedSessionIdRef).catch((e) => diag(`chat.persist failed: ${e?.message || 'idb error'}`));
}

let scheduledPersistTimer: number | null = null;

/** Persist the current reconciled transcript after a short quiet period.
 *  The transcript pipeline updates existing DOM nodes for durable replay
 *  and streaming deltas; without this hook, the boot-time DOM snapshot can
 *  remain older than the canonical store and briefly reappear on refresh. */
export function scheduleSnapshotPersist(delayMs = 250): void {
  if (scheduledPersistTimer != null) {
    window.clearTimeout(scheduledPersistTimer);
  }
  scheduledPersistTimer = window.setTimeout(() => {
    scheduledPersistTimer = null;
    persist();
  }, delayMs);
}

/** Public flush helper — callers that batch many addLine calls (e.g.
 *  `replaySessionMessages` rendering a 200-message chat) skip the
 *  per-line autoScroll + persist via `batch: true`, then call this
 *  ONCE at the end. Without batching, the resume loop is O(N²): each
 *  `persist()` reads `transcriptEl.innerHTML` (O(N) DOM serialization)
 *  and writes the full snapshot to IDB — N calls × O(N) bytes per
 *  call. Field repro 2026-05-04: 200-msg chat took ~5s to render
 *  client-side (server-side fetch was <1s). Pre-existing slowness;
 *  surfaced when the cascade fix made click-to-content the dominant
 *  load-time component. */
export function flushBatchedRender(): void {
  autoScroll();
  persist();
}

export function speakerLabel(id: string | number | null | undefined): string {
  if (id == null) return 'Speaker';
  if (!speakerNames[id]) speakerNames[id] = `Speaker ${++speakerCount}`;
  return speakerNames[id];
}

/** Format a timestamp as HH:MM (24h) for top-right display on each line. */
function formatTime(ts: number | Date | string): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

/** Append (or prepend) a line to the transcript. Returns the rendered
 *  `<div>` so callers can attach pending/failed state. Returns `null`
 *  if the transcript element hasn't been wired via `init()` yet. */
export function addLine(speaker: string, text: string, cls = '', opts: {
  /** Input source indicator — voice or typed (drives the small icon
   *  next to the speaker label). */
  source?: 'voice' | 'text' | 'sent';
  /** Render `text` as markdown (used for agent replies). */
  markdown?: boolean;
  /** Message timestamp; defaults to now. */
  timestamp?: number | Date | string;
  /** Image / video thumbnails rendered under the line. */
  attachments?: Array<{ dataUrl: string; mimeType: string; fileName?: string }>;
  /** TTS reply id for agent lines — links bubble to playback events
   *  (loading bar + play-icon wiring). */
  replyId?: string;
  /** Adapter-side message id (e.g. SSE `message_id`). Stored as
   *  `data-message-id` so handlers can dedup an envelope arriving for a
   *  message a parallel render path (history fetch) has already
   *  surfaced. */
  messageId?: string;
  /** Insert at the top of the transcript instead of appending. Used by
   *  lazy-loaded history. */
  prepend?: boolean;
  /** Skip autoScroll + persist. Caller runs them once after the batch.
   *  Used by prependHistory to preserve scroll position and avoid N IDB writes. */
  batch?: boolean;
  /** Mark the bubble `.pending` — visual signal that the send is in flight.
   *  Caller is responsible for calling `markBubbleFinalized` / `markBubbleFailed`
   *  via the returned div. Used by the atomic-send path (Q1). */
  pending?: boolean;
} = {}): HTMLElement | null {
  if (!transcriptEl) return null;
  const div = document.createElement('div');
  div.className = `line ${cls}${opts.pending ? ' pending' : ''}`;
  if (opts.replyId) div.dataset.replyId = opts.replyId;
  if (opts.messageId) div.dataset.messageId = String(opts.messageId);
  if (cls.includes('agent')) div.dataset.text = text;  // replyPlayer uses this for replay

  // Source icon: minimal line-style indicator of voice vs typed
  const micSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 1.5a2 2 0 0 0-2 2v4a2 2 0 0 0 4 0v-4a2 2 0 0 0-2-2z"/><path d="M4 7a4 4 0 0 0 8 0"/><path d="M8 12v2.5M6 14.5h4"/></svg>`;
  const kbdSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="1" y="3.5" width="14" height="9" rx="1.5"/><path d="M4 10.5h8"/><circle cx="5" cy="7" r="0.5" fill="currentColor"/><circle cx="8" cy="7" r="0.5" fill="currentColor"/><circle cx="11" cy="7" r="0.5" fill="currentColor"/></svg>`;
  const sourceIcon = opts.source === 'voice' ? `<span class="source-icon" title="voice">${micSvg}</span>`
    : opts.source === 'text' ? `<span class="source-icon" title="typed">${kbdSvg}</span>`
    : '';

  const speakerSpan = `<span class="speaker">${sourceIcon}${escapeHtml(speaker)}:</span> `;
  // For plain (non-markdown) lines — typically user input — preserve
  // line breaks. escapeHtml has already neutralized `<` and `>`, so the
  // injected <br> is the only HTML tag in the output. Without this,
  // long multi-paragraph prompts collapse into a wall of text in the
  // bubble, which surprised users typing multi-line prompts and made
  // it harder to spot embedded URLs / blank-line separated sections.
  const rendered = opts.markdown
    ? miniMarkdown(text)
    : escapeHtml(text).replace(/\n/g, '<br>');
  div.innerHTML = speakerSpan + `<span class="text">${rendered}</span>`;

  // Timestamp — top-right, left of the copy icon
  const ts = opts.timestamp ?? Date.now();
  const tsEl = document.createElement('span');
  tsEl.className = 'line-ts';
  tsEl.textContent = formatTime(ts);
  tsEl.title = new Date(ts).toLocaleString();
  div.appendChild(tsEl);

  // Copy button — standard overlapping-rectangles icon
  const copySvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5V3.5a1.5 1.5 0 0 1 1.5-1.5h7"/></svg>`;
  const checkSvg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8.5l3.5 3.5 6.5-8"/></svg>`;
  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy-btn';
  copyBtn.title = 'Copy text';
  copyBtn.innerHTML = copySvg;
  copyBtn.onclick = (e) => {
    e.stopPropagation();
    // Read text live from the bubble (not the closure `text` arg), since
    // agent streaming mutates .text span + dataset.text after creation.
    // Prefer dataset.text (raw source) for agent lines — lossless for
    // round-trip paste. Falls back to textContent (strips speaker label
    // since it's in a separate .speaker span).
    const liveText = div.dataset.text
      || (div.querySelector('.text') as HTMLElement | null)?.textContent
      || '';
    navigator.clipboard.writeText(liveText).then(() => {
      copyBtn.innerHTML = checkSvg;
      setTimeout(() => { copyBtn.innerHTML = copySvg; }, 1500);
    });
  };
  div.appendChild(copyBtn);

  // Per-bubble pin toggle — adds the bubble to the pinned-messages
  // store (drives the right-side pins drawer's cross-chat aggregation).
  // Shown on any bubble with a stable msgId. The chat_id is resolved
  // LAZILY at click time from viewedSessionIdRef so the button works
  // even on optimistic user bubbles rendered before trackViewedSession
  // has stamped the chat id (fresh-new-chat path: send() runs before
  // backend.newSession() completes its assignment). Without the lazy
  // read, the fresh-new-chat smoke caught the button missing entirely
  // (2026-05-12).
  //
  // Icon swap is CSS-driven (.pin-btn.pinned hides outline, shows
  // filled) so the global sidekick:pins-changed listener at init()
  // only needs to toggle the `.pinned` class — no innerHTML rebuild
  // per repaint cycle.
  if (opts.messageId) {
    const msgId = String(opts.messageId);
    const pinBtn = document.createElement('button');
    pinBtn.className = 'pin-btn';
    // Thumbtack — recognizable as a pin (vs the abstract paperclip
     // shape used pre-2026-05-12 that Jonathan correctly flagged as
     // ambiguous). Two SVGs in DOM; CSS swaps visibility via .pinned.
    pinBtn.innerHTML = `
      <svg class="pin-icon pin-outline" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 10.76V4h6v6.76l3 1.74v2.5H6v-2.5z"/></svg>
      <svg class="pin-icon pin-filled" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 17v5" stroke-linecap="round"/><path d="M9 10.76V4h6v6.76l3 1.74v2.5H6v-2.5z"/></svg>
    `;
    // Initial paint: we don't know the chat_id yet if this is an
    // optimistic bubble on a fresh chat. Re-paint will fire via
    // sidekick:pins-changed once trackViewedSession stamps it.
    if (viewedSessionIdRef && isPinMsg(viewedSessionIdRef, msgId)) {
      pinBtn.classList.add('pinned');
      pinBtn.title = 'Unpin message';
      div.classList.add('pinned');
    } else {
      pinBtn.title = 'Pin message';
    }
    pinBtn.onclick = (e) => {
      e.stopPropagation();
      // viewedSessionIdRef is set by replaySessionMessages (drawer
      // click path), but fresh-new-chat optimistic bubbles render
      // BEFORE that fires. Fall back to backend.getCurrentSessionId
      // which the adapter tracks on every send/new-chat operation
      // — gives a correct chatId for the fresh-chat case the smoke
      // pin-toggle-on-bubble pins.
      const chatId = viewedSessionIdRef || backend.getCurrentSessionId?.() || null;
      if (!chatId) {
        log(`[pin-click] no viewed/current chat — bailing (msgId=${msgId})`);
        return;
      }
      const currentlyPinned = isPinMsg(chatId, msgId);
      log(`[pin-click] chat=${chatId} msgId=${msgId} currentlyPinned=${currentlyPinned}`);
      if (currentlyPinned) {
        void unpinMessage(chatId, msgId);
        pinBtn.classList.remove('pinned');
        pinBtn.title = 'Pin message';
        div.classList.remove('pinned');
      } else {
        // Pull the live text — same lossless source the copy button
        // uses (dataset.text for streaming agent lines, .text span
        // otherwise). Truncate to ~280 chars so the drawer doesn't
        // store entire pasted documents.
        const liveText = div.dataset.text
          || (div.querySelector('.text') as HTMLElement | null)?.textContent
          || '';
        // Store up to ~16000 chars so even a long markdown reply (pitch
        // deck section, brainstorm, planning doc) shows IN FULL when
        // the drawer item expands. Earlier 1500 cap truncated common
        // expanded reads (Jonathan field bug 2026-05-14: expanded pin
        // body was cut off mid-section). 16K is well under IDB pressure
        // for any realistic pin count (1 MB at 60 pins of max size).
        const preview = liveText.length > 16000 ? liveText.slice(0, 15997) + '…' : liveText;
        const role = cls.includes('agent') ? 'assistant'
          : cls.includes('system') ? 'system'
          : 'user';
        const ts = typeof opts.timestamp === 'number' ? opts.timestamp
          : opts.timestamp instanceof Date ? opts.timestamp.getTime()
          : typeof opts.timestamp === 'string' ? Date.parse(opts.timestamp)
          : Date.now();
        void pinMessage({ chatId, msgId, role, text: preview, timestamp: ts });
        pinBtn.classList.add('pinned');
        pinBtn.title = 'Unpin message';
        div.classList.add('pinned');
      }
    };
    div.appendChild(pinBtn);
  }

  // Per-bubble play/pause chip + playback bar for AGENT lines. The
  // DOM is emitted here; ALL interaction (click, scrub, class-flip,
  // bar widths) is owned by src/audio/turn-based/replyPlayer.ts via
  // delegated handlers on the transcript element. No per-bubble
  // listener attachment — new bubbles "just work."
  //
  // Both play + pause SVGs are emitted; CSS swaps visibility based on
  // .tts-playing state. Color encodes cache state via .tts-cached.
  // Bar layers (.play-bar-loaded under .play-bar-played) are present
  // in the DOM but invisible until styled by .tts-active states —
  // see styles/app.css for the visual spec.
  if (cls.includes('agent')) {
    const playGlyph = `<svg class="glyph-play" viewBox="0 0 16 16" fill="none"><polygon points="5 3 13 8 5 13 5 3" fill="currentColor"/></svg>`;
    const pauseGlyph = `<svg class="glyph-pause" viewBox="0 0 16 16" fill="none"><rect x="4" y="3" width="3" height="10" fill="currentColor"/><rect x="9" y="3" width="3" height="10" fill="currentColor"/></svg>`;
    // Loading spinner — minimal line-style ring; CSS spins it via
    // @keyframes when .tts-streaming is on the bubble. Replaces the
    // play glyph during /tts fetch so the user sees "loading, hands
    // off" instead of an unchanged play button (tap-then-nothing was
    // the field-bug: 6 taps over 80s while waiting for the first one).
    const loadingGlyph = `<svg class="glyph-loading" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"><path d="M14 8a6 6 0 1 1-3-5.196"/></svg>`;
    const playBtn = document.createElement('button');
    playBtn.className = 'play-btn';
    playBtn.title = 'Play / pause this reply';
    playBtn.innerHTML = playGlyph + pauseGlyph + loadingGlyph;
    div.appendChild(playBtn);

    const bar = document.createElement('div');
    bar.className = 'play-bar';
    bar.innerHTML = `<div class="play-bar-loaded"></div><div class="play-bar-played"></div>`;
    div.appendChild(bar);
  }

  // All links in rendered markdown open in new tab
  if (opts.markdown) {
    div.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
  }

  // Attachment thumbnails — images render as tappable <img>, videos as
  // in-place <video controls>. Both link out via the lightbox for a
  // larger view. Gateway handling is permissive: it bundles both as
  // `type: 'image'` blocks; which models accept video is model-
  // specific (Gemini / some Gemma variants do).
  if (Array.isArray(opts.attachments) && opts.attachments.length > 0) {
    const attDiv = document.createElement('div');
    attDiv.className = 'line-attachments';
    for (const att of opts.attachments) {
      if (!att?.dataUrl) continue;
      if (att.mimeType?.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = att.dataUrl;
        img.alt = att.fileName || 'attachment';
        img.title = att.fileName || 'attachment';
        img.loading = 'lazy';
        img.onclick = () => openLightbox(att.dataUrl);
        attDiv.appendChild(img);
      } else if (att.mimeType?.startsWith('video/')) {
        const vid = document.createElement('video');
        vid.src = att.dataUrl;
        vid.controls = true;
        vid.preload = 'metadata';
        vid.playsInline = true;
        vid.title = att.fileName || 'attachment';
        attDiv.appendChild(vid);
      } else if (att.mimeType === 'application/pdf') {
        // PDF preview: minimal label chip. Click opens the data: URL in
        // a new tab so the user can sanity-check what they sent without
        // pdf.js bulk. Local-only — the chip lives in DOM memory and
        // disappears on hard refresh (Jonathan, 2026-05-05: "no need
        // to push to backend, can just live locally").
        const a = document.createElement('a');
        a.href = att.dataUrl;
        a.target = '_blank';
        a.rel = 'noopener';
        a.className = 'pdf-chip';
        a.title = att.fileName || 'PDF attachment';
        a.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 1.5h7L13 4.5V14a.5.5 0 0 1-.5.5h-9A.5.5 0 0 1 3 14V1.5z"/><path d="M9.5 1.5V4.5H13"/></svg><span class="pdf-chip-label">${escapeHtml(att.fileName || 'PDF')}</span>`;
        attDiv.appendChild(a);
      }
    }
    if (attDiv.children.length > 0) div.appendChild(attDiv);
  }

  // Long-bubble fold (Jonathan, 2026-05-05). Bubbles whose source text
  // exceeds the threshold get clipped with a "Show more" toggle. Per-
  // bubble state lives in `foldStateByMsgId` so a virt unmount/remount
  // preserves the user's toggle — the bubble's DOM is gone after a
  // scroll-out, but msgId is stable; remount restores the prior state
  // via the map lookup below.
  // CSS in app.css controls the preview height (--bubble-fold-preview-lines)
  // and fade. Threshold lives here so it scales with content type
  // (markdown lines render shorter than user-typed lines).
  // Streaming agent bubbles: this fires at addLine time on the initial
  // text. If a streamed bubble grows past the threshold mid-stream, no
  // fold (acceptable v1 limitation; most long bubbles are pasted/replayed).
  const FOLD_THRESHOLD_CHARS = 1500;
  const FOLD_THRESHOLD_LINES = 25;
  const lineCount = (text.match(/\n/g) || []).length + 1;
  if (text.length > FOLD_THRESHOLD_CHARS || lineCount > FOLD_THRESHOLD_LINES) {
    div.classList.add('foldable');
    // Default state: agent replies start EXPANDED (you usually want to read
    // them in full); user bubbles start FOLDED (own messages are reference,
    // collapse by default to save scroll real estate). Per Jonathan, 2026-
    // 05-05. Either side can be toggled per-bubble.
    const defaultExpanded = cls.includes('agent');
    const persistedState = opts.messageId ? foldStateByMsgId.get(String(opts.messageId)) : undefined;
    const startExpanded = persistedState === undefined ? defaultExpanded : persistedState === 'expanded';
    if (startExpanded) div.classList.add('expanded');
    const foldBtn = document.createElement('button');
    foldBtn.className = 'bubble-fold-toggle';
    foldBtn.textContent = startExpanded ? 'Show less' : 'Show more';
    foldBtn.onclick = (e) => {
      e.stopPropagation();
      const expanded = div.classList.toggle('expanded');
      foldBtn.textContent = expanded ? 'Show less' : 'Show more';
      if (opts.messageId) foldStateByMsgId.set(String(opts.messageId), expanded ? 'expanded' : 'collapsed');
    };
    div.appendChild(foldBtn);
  }

  // Under virtualization, target the virtualizer's slot so the line
  // lands inside the scrollable content area rather than after the
  // bottom spacer. Falls back to transcriptEl when virt is off.
  const target = contentTarget();
  if (!target) return null;
  if (opts.prepend) {
    target.insertBefore(div, target.firstChild);
  } else {
    target.appendChild(div);
  }
  if (!opts.batch) {
    autoScroll();
    persist();
  }
  return div;
}

// ─── Lazy-load / pagination ─────────────────────────────────────────────────

let paginationOldestId: number | null = null;
let paginationHasMore = false;
let paginationLoading = false;
let paginationCb: ((beforeId: number) => Promise<void>) | null = null;
/** Pixels from the top that trigger a background "load earlier" fetch. */
const LOAD_EARLIER_THRESHOLD_PX = 150;

/** Called by main.ts after replaying a page of session history so chat
 *  knows whether there's older content to fetch and what cursor to use.
 *  Pass oldestId=null, hasMore=false to disable pagination (e.g. for
 *  fresh sessions or cached replays with the full transcript). */
export function setPaginationState(oldestId: number | null, hasMore: boolean) {
  paginationOldestId = oldestId;
  paginationHasMore = hasMore;
  paginationLoading = false;
}

/** Register the cursor-to-messages callback. Called once on boot; the cb
 *  is expected to fetch, prepend via prependHistory(), and re-call
 *  setPaginationState with the new cursor. */
export function onLoadEarlier(cb: (beforeId: number) => Promise<void>) {
  paginationCb = cb;
}

/** Batch-prepend historical messages while preserving the user's scroll
 *  position. renderFn should call addLine(..., {prepend: true, batch: true})
 *  per message, iterating oldest→newest so chronological order is
 *  preserved at the top of the transcript. */
export function prependHistory(renderFn: () => void) {
  if (!transcriptEl) { renderFn(); return; }
  // Under virt the scrollHeight delta uses CACHE heights for newly-
  // prepended (unmeasured) specs. Cache defaults underestimate by
  // 50-100px each compared to actual measured heights, so the bump
  // computed below leaves the user staring at a bubble 100s of px off
  // their pre-prepend anchor. Use the virtualizer's DOM-truth anchor
  // pair instead: capture {key, offsetPx} from the first-visible
  // bubble, then restore against the same key after the prepend +
  // rerender. The 2-rAF refinement in restoreAnchor measures actual
  // heights and corrects any cache-driven drift.
  const virt = getVirtualizer();
  if (virt) {
    const anchor = virt.getAnchor();
    renderFn();
    if (anchor) virt.restoreAnchor(anchor);
    persist();
    return;
  }
  const oldScrollTop = transcriptEl.scrollTop;
  const oldScrollHeight = transcriptEl.scrollHeight;
  renderFn();
  const newScrollHeight = transcriptEl.scrollHeight;
  transcriptEl.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
  persist();
}

/** Drill-scroll guard: while a pin-drawer / cmdk drill is scrolling
 *  the target message into view, suppress lazy-load. Without this,
 *  scrolling near the top of the transcript triggers maybeLoadEarlier
 *  mid-flight; the resulting prepend shifts the target's y-coordinate
 *  but the smooth-scroll keeps animating to the *old* coordinate,
 *  landing the user on an "earlier" message. Each successive click
 *  triggers another page until pagination exhausts — the field bug
 *  Jonathan called "takes 3 tries to land on the right message"
 *  (2026-05-13). suppressLoadEarlierFor sets a deadline; maybeLoadEarlier
 *  bails until it passes. */
let suppressLoadEarlierUntil = 0;
export function suppressLoadEarlierFor(ms: number): void {
  suppressLoadEarlierUntil = Math.max(suppressLoadEarlierUntil, Date.now() + ms);
}

async function maybeLoadEarlier() {
  if (Date.now() < suppressLoadEarlierUntil) return;
  if (!paginationHasMore || paginationLoading || !paginationCb || paginationOldestId == null) return;
  if (!transcriptEl) return;
  if (transcriptEl.scrollTop > LOAD_EARLIER_THRESHOLD_PX) return;
  paginationLoading = true;
  const cursor = paginationOldestId;
  try {
    await paginationCb(cursor);
  } catch (e: any) {
    diag(`chat.loadEarlier failed: ${e?.message || e}`);
  } finally {
    paginationLoading = false;
  }
}

/** Open a full-screen overlay showing the given image. Tap anywhere to dismiss. */
function openLightbox(src: string): void {
  document.getElementById('lightbox')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'lightbox';
  overlay.onclick = () => overlay.remove();
  const img = document.createElement('img');
  img.src = src;
  overlay.appendChild(img);
  document.body.appendChild(overlay);
}

/** Render a muted, italic, centered "system" line — for session events
 *  like model changes or new-chat resets. Distinct visually from regular
 *  agent/user messages. */
export function addSystemLine(text: string): HTMLElement | null {
  const target = contentTarget();
  if (!target) return null;
  const div = document.createElement('div');
  div.className = 'line system';
  div.textContent = text;
  target.appendChild(div);
  autoScroll();
  persist();
  return div;
}

/** Clear transcript and persisted state (used by refresh). */
export function clear(): void {
  if (transcriptEl) transcriptEl.innerHTML = '';
  viewedSessionIdRef = null;
  restoredViewedSessionId = null;
  foldStateByMsgId.clear();
  clearSnapshot().catch(() => {});
}

/** Atomic-bubble (Q1): drop the `.pending` class once the send has
 *  been ack'd by the agent (first reply_delta / typing arrived). */
export function markBubbleFinalized(div: HTMLElement | null): void {
  if (!div) return;
  div.classList.remove('pending');
  persist();
}

/** Atomic-bubble (Q1): mark the bubble `.failed` with a retry/dismiss
 *  affordance. `onRetry` re-attempts the send (caller restores
 *  composer text + removes the bubble inside the handler).
 *  `onDismiss` removes the bubble without retry. */
export function markBubbleFailed(
  div: HTMLElement | null,
  opts: { onRetry?: () => void; onDismiss?: () => void } = {},
): void {
  if (!div) return;
  div.classList.remove('pending');
  div.classList.add('failed');
  // Don't double-add the row if marked failed twice.
  if (div.querySelector('.send-failed-row')) return;
  const row = document.createElement('div');
  row.className = 'send-failed-row';
  const label = document.createElement('span');
  label.textContent = 'Send failed.';
  row.appendChild(label);
  if (opts.onRetry) {
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.onclick = (e) => {
      e.preventDefault();
      div.remove();
      opts.onRetry?.();
    };
    row.appendChild(retry);
  }
  if (opts.onDismiss) {
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.onclick = (e) => {
      e.preventDefault();
      div.remove();
      opts.onDismiss?.();
    };
    row.appendChild(dismiss);
  }
  div.appendChild(row);
  persist();
}
