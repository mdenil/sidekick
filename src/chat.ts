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
} from './chatScrollPositions.ts';

let transcriptEl: HTMLElement | null = null;
let scrollToBottomBtn: HTMLElement | null = null;
const speakerNames: Record<string | number, string> = {};
let speakerCount = 0;

/** In-memory mirror of the session id the current chat view corresponds to.
 *  Set by replaySessionMessages → trackViewedSession(id), cleared on
 *  chat.clear() so a New chat rotation doesn't keep a stale id in the
 *  next persisted snapshot. Stored alongside the HTML on persist so
 *  reload can restore the drawer highlight to the right row. */
let viewedSessionIdRef: string | null = null;

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
 *  Generous threshold (300) plus user-vs-JS scroll distinction (see
 *  USER_SCROLL_GRACE_MS) — 300 alone wasn't enough on a fast realtime
 *  reply because scrollHeight kept outpacing autoScroll. The real fix
 *  is only re-evaluating pinnedToBottom on USER-initiated scrolls
 *  (touchmove / wheel), not the scroll events fired by our own
 *  scrollTop assignments. */
const PINNED_THRESHOLD_PX = 300;
/** Window after a user touchmove / wheel event during which subsequent
 *  scroll events are attributed to that user gesture. Outside the window
 *  scroll events are assumed JS-initiated and don't update pinnedToBottom.
 *  iOS momentum scrolling can fire scroll events for ~500ms after the
 *  finger lifts, so we need a generous grace window. */
const USER_SCROLL_GRACE_MS = 800;
let lastUserScrollAt = 0;

let pinnedToBottom = true;
let missedWhileScrolled = 0;

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
  // Re-pin during the 2s window after this call to catch async content
  // reflow (image natural-size resolution, code-block syntax highlight,
  // link-preview card render) that grows scrollHeight AFTER the
  // synchronous scrolls fire. Without this, switching to a chat with
  // images near the bottom lands the user mid-chat instead of at the
  // live edge (Jonathan, 2026-05-12 field bug). Bounded so we don't
  // fight a user who manually scrolls up immediately after the call.
  scheduleReflowRepin();
}

/** Re-pin to bottom during async reflow. Watches the transcript for
 *  scrollHeight growth in the 2s window after a forceScrollToBottom
 *  call; if it grows AND the user hasn't manually scrolled up, fire
 *  another scrollTo(scrollHeight). Disposed automatically at window
 *  end so it doesn't fight a steady-state user scroll-up. */
let reflowRepinObserver: ResizeObserver | null = null;
let reflowRepinTimer: ReturnType<typeof setTimeout> | null = null;
const REFLOW_REPIN_WINDOW_MS = 2000;
function scheduleReflowRepin(): void {
  if (!transcriptEl) return;
  if (typeof ResizeObserver === 'undefined') return;
  // Tear down any prior watcher — only one window active at a time.
  if (reflowRepinObserver) { reflowRepinObserver.disconnect(); reflowRepinObserver = null; }
  if (reflowRepinTimer) { clearTimeout(reflowRepinTimer); reflowRepinTimer = null; }
  // Capture user-scroll baseline so we don't override an explicit
  // upward scroll initiated during the window.
  const repinStartedAt = Date.now();
  const ro = new ResizeObserver(() => {
    if (!transcriptEl) return;
    // If the user scrolled by hand since the repin started, stop —
    // we'd otherwise yank their reading position back to the bottom.
    if (lastUserScrollAt > repinStartedAt) {
      if (reflowRepinObserver) { reflowRepinObserver.disconnect(); reflowRepinObserver = null; }
      return;
    }
    // Still pinned (within threshold) — re-snap to the new bottom.
    if (pinnedToBottom) {
      transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: 'instant' as ScrollBehavior });
    }
  });
  ro.observe(transcriptEl);
  reflowRepinObserver = ro;
  reflowRepinTimer = setTimeout(() => {
    if (reflowRepinObserver) { reflowRepinObserver.disconnect(); reflowRepinObserver = null; }
    reflowRepinTimer = null;
  }, REFLOW_REPIN_WINDOW_MS);
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
    if (inBurst) {
      transcriptEl.scrollTo({ top: transcriptEl.scrollHeight, behavior: 'instant' as ScrollBehavior });
    } else {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }
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
  // cache so sessionResume can branch synchronously on switch-in
  // (restore vs scroll-to-bottom). Best-effort — failures just mean
  // every chat takes the scroll-to-bottom fallback path.
  void hydrateScrollPositions();

  // Jump-to-bottom button wiring. The button lives outside the transcript
  // scroller (as a sibling inside .chat-column) so it stays fixed while
  // the transcript scrolls.
  scrollToBottomBtn = document.getElementById('scroll-to-bottom');
  if (scrollToBottomBtn) {
    scrollToBottomBtn.addEventListener('click', () => forceScrollToBottom());
  }
  if (transcriptEl) {
    // Mark user-initiated scrolls. iOS fires scroll events both during
    // user touch and during JS scrollTop= assignments — we can't tell
    // them apart from inside the scroll handler. Track the last time
    // a user gesture (touch / wheel) fired and only re-evaluate
    // pinnedToBottom when the scroll event lands within the grace
    // window after a user gesture. JS-initiated scrolls outside that
    // window leave pinnedToBottom alone.
    transcriptEl.addEventListener('touchmove', () => { lastUserScrollAt = Date.now(); }, { passive: true });
    transcriptEl.addEventListener('wheel', () => { lastUserScrollAt = Date.now(); }, { passive: true });
    transcriptEl.addEventListener('scroll', () => {
      const userInitiated = (Date.now() - lastUserScrollAt) < USER_SCROLL_GRACE_MS;
      // Lazy-load older history runs regardless — it cares about
      // scroll-near-top, not user vs JS.
      maybeLoadEarlier();
      // Save per-chat scroll position on EVERY scroll (user or JS).
      // isPinned() at this moment is the source of truth — touch
      // inertia past USER_SCROLL_GRACE_MS, jump-to-bottom button,
      // streaming auto-scroll, and forceScrollToBottom all fire JS-
      // initiated scrolls that nonetheless represent the user's
      // intended position. Gating on userInitiated dropped at-bottom
      // restoration entirely for those paths (Jonathan, 2026-05-12:
      // "i scroll to bottom - switch away - switch back - still at
      // middle. i literally can't even do that."). 500ms debounce
      // inside the helper keeps streaming-cadence cheap.
      if (transcriptEl && viewedSessionIdRef) {
        saveScrollPosition(viewedSessionIdRef, {
          scrollTop: transcriptEl.scrollTop,
          atBottom: isPinned(),
        });
      }
      if (!userInitiated) return;
      const wasPinned = pinnedToBottom;
      pinnedToBottom = isPinned();
      if (pinnedToBottom !== wasPinned && transcriptEl) {
        const distance = transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight;
        diag(`[autoscroll] pinnedToBottom ${wasPinned}→${pinnedToBottom} (user-initiated, distance=${distance})`);
      }
      if (pinnedToBottom && !wasPinned) missedWhileScrolled = 0;
      updateButton();
    }, { passive: true });
  }

  try {
    const saved = await loadSnapshot();
    if (saved && transcriptEl) {
      transcriptEl.innerHTML = saved.html;
      restoredViewedSessionId = saved.sessionId || null;
      viewedSessionIdRef = restoredViewedSessionId;
      // Strip stale memo cards — their audio element + blob reference are dead
      // after serialization. Caller will re-render them fresh from IndexedDB.
      transcriptEl.querySelectorAll('.memo-card').forEach(el => el.remove());
      // Initial load: always jump to latest regardless of the default
      // pinned-to-bottom state.
      forceScrollToBottom();
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
 *  main.ts) in case the IDB write fails mid-flight. */
function persist(): void {
  if (!transcriptEl) return;
  const html = transcriptEl.innerHTML;
  saveSnapshot(html, viewedSessionIdRef).catch((e) => diag(`chat.persist failed: ${e?.message || 'idb error'}`));
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
  // bubble state is in-memory only — resets on reload, by design.
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
    const startExpanded = cls.includes('agent');
    if (startExpanded) div.classList.add('expanded');
    const foldBtn = document.createElement('button');
    foldBtn.className = 'bubble-fold-toggle';
    foldBtn.textContent = startExpanded ? 'Show less' : 'Show more';
    foldBtn.onclick = (e) => {
      e.stopPropagation();
      const expanded = div.classList.toggle('expanded');
      foldBtn.textContent = expanded ? 'Show less' : 'Show more';
    };
    div.appendChild(foldBtn);
  }

  if (opts.prepend) {
    transcriptEl.insertBefore(div, transcriptEl.firstChild);
  } else {
    transcriptEl.appendChild(div);
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
  const oldScrollTop = transcriptEl.scrollTop;
  const oldScrollHeight = transcriptEl.scrollHeight;
  renderFn();
  const newScrollHeight = transcriptEl.scrollHeight;
  transcriptEl.scrollTop = oldScrollTop + (newScrollHeight - oldScrollHeight);
  persist();
}

async function maybeLoadEarlier() {
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
  if (!transcriptEl) return null;
  const div = document.createElement('div');
  div.className = 'line system';
  div.textContent = text;
  transcriptEl.appendChild(div);
  autoScroll();
  persist();
  return div;
}

/** Clear transcript and persisted state (used by refresh). */
export function clear(): void {
  if (transcriptEl) transcriptEl.innerHTML = '';
  viewedSessionIdRef = null;
  restoredViewedSessionId = null;
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
