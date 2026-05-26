/**
 * @fileoverview Crack A — transcript pipeline bootstrap.
 *
 * Wires the store → projection → reconciler chain to the live
 * transcript element. Called once from main.ts boot. After this,
 * every mutation through the store (setDurable, appendInflight,
 * addPendingSend, …) automatically re-renders the active chat.
 *
 * Background-chat events still mutate the store but the reconciler
 * skips them — they re-render on the next session switch.
 */

import { project } from './projection.ts';
import { reconcile } from './reconciler.ts';
import { getState, subscribe } from './store.ts';
import { scheduleSnapshotPersist, runWithScrollSaveSuppressed } from '../chat.ts';
import { bindVirtualizer as bindVirt, type VirtualizerHandle } from './virtualizer.ts';

export {
  bindVirtualizer,
  createHeightCache,
  computeVisibleWindow,
  computeAnchor,
  scrollTopForAnchor,
} from './virtualizer.ts';
export type {
  SavedAnchor,
  VisibleWindow,
  HeightCache,
  VirtualizerOpts,
  VirtualizerHandle,
} from './virtualizer.ts';

let getTranscriptEl: () => HTMLElement | null = () => document.getElementById('transcript');
let getViewedChatId: () => string | null = () => null;

/** Lazily-bound virtualizer instance when the feature flag is on.
 *  Created on first rerenderInto call after bindTranscriptPipeline,
 *  reused for the lifetime of the page. Null when the flag is off
 *  (production default until Phase 5). */
let virtualizer: VirtualizerHandle | null = null;

export interface BindOpts {
  transcriptEl: () => HTMLElement | null;
  getViewedChatId: () => string | null;
}

/** Returns true if the virtualizer should be used for transcript
 *  rendering. Phase 5a attempt at default-on (2026-05-25) was reverted
 *  because 21 of 134 mocked smokes were tightly coupled to default-path
 *  mechanics (scrollTop semantics, "all bubbles in DOM" assumptions,
 *  load-earlier prepend math, replyPlayer DOM-class state, etc.).
 *  These need per-smoke audits — most are test-quality issues, not
 *  virt bugs — before the default can flip safely. Today: opt-in only
 *  via `localStorage['sidekick.virtualize'] = '1'` or `?virt=1`. */
export function isVirtualizerEnabled(): boolean {
  try {
    if (typeof window !== 'undefined') {
      // Explicit opt-OUT wins over the default.
      if (window.localStorage?.getItem('sidekick.virtualize') === '0') return false;
      // `?virt=0` is a sticky disable; `?virt=1` clears any prior
      // explicit opt-out. Either way the URL param persists to
      // localStorage so PWA shortcuts that drop the query string still
      // honor the user's intent.
      if (typeof window.location !== 'undefined') {
        const sp = new URLSearchParams(window.location.search);
        const v = sp.get('virt');
        if (v === '0') {
          try { window.localStorage?.setItem('sidekick.virtualize', '0'); } catch {}
          return false;
        }
        if (v === '1') {
          try { window.localStorage?.removeItem('sidekick.virtualize'); } catch {}
          return true;
        }
      }
    }
  } catch { /* SSR / privacy mode — fall through to default */ }
  return true;
}

/** Slot element the virtualizer renders into, when active. Exposed
 *  so legacy chat.addLine consumers (system delimiter lines,
 *  backfillHistory's quick paint) can target the same content area
 *  the reconciler writes to — without it, those appends would land
 *  AFTER the bottom spacer and visually disconnect from the
 *  transcript. Returns null when the virtualizer isn't active;
 *  callers fall back to the transcript element directly. */
export function getVirtualizerSlot(): HTMLElement | null {
  if (!virtualizer) return null;
  const el = getTranscriptEl();
  if (!el) return null;
  // The bindVirtualizer factory creates exactly one `.transcript-slot`
  // child. Cheap lookup; the slot is permanent for the page lifetime.
  return el.querySelector(':scope > .transcript-slot');
}

/** Expose the live handle for consumers that need scroll/anchor APIs
 *  (sessionResume's restore path, chat.ts's pinned/scroll utilities
 *  in Phase 3). Null when the virtualizer isn't active. */
export function getVirtualizer(): VirtualizerHandle | null {
  return virtualizer;
}

/** Wire the store to the DOM. Returns an unsubscribe fn (mainly for
 *  tests; production never unbinds). */
export function bindTranscriptPipeline(opts: BindOpts): () => void {
  getTranscriptEl = opts.transcriptEl;
  getViewedChatId = opts.getViewedChatId;
  return subscribe((chatId) => {
    // Match the legacy "viewed gate" semantics from main.ts:
    // skip ONLY when viewed is set AND explicitly differs. A null
    // viewed (boot before setViewed fires, fresh-PWA-first-send
    // before any drawer click) renders the change — there's no
    // other chat on screen to protect.
    const viewed = getViewedChatId();
    if (viewed && chatId !== viewed) return;
    rerenderInto(chatId);
  });
}

/** Switch-then-load: blank the transcript + show the loading spinner
 *  IMMEDIATELY when the user clicks a different chat row, before the
 *  incoming transcript is ready. Pure in-DOM operation — empties the
 *  rendered content and adds the `.transcript-loading` class (the CSS
 *  spinner fades in after 200ms; a fast cache hit clears it first via
 *  rerenderInto's `specs.length > 0` removal so no flash). Decoupled
 *  from any IDB persistence: the click handler calls this synchronously,
 *  and "which session is viewed" stays on its existing async path. This
 *  is why it can't reintroduce the IDB-pagehide race that reverted the
 *  prior attempt — nothing here writes to (or awaits) IndexedDB.
 *
 *  Handles both render paths:
 *   - virtualizer active → clearContent() blanks the slot in place,
 *     keeping the scaffold for the next setSpecs.
 *   - default path → empty #transcript directly. */
export function showTranscriptLoading(): void {
  const el = getTranscriptEl();
  if (!el) return;
  // Emptying the transcript collapses its scrollHeight and fires a
  // synthetic scroll-to-0 event while the LEAVING chat is still the
  // viewed one. Suppress the scroll listener's position-save across the
  // clear so that synthetic scroll doesn't clobber the leaving chat's
  // just-saved position with a garbage (empty-transcript) anchor.
  runWithScrollSaveSuppressed(() => {
    if (virtualizer) {
      virtualizer.clearContent();
    } else {
      el.innerHTML = '';
    }
  });
  el.classList.add('transcript-loading');
}

/** Force a re-render of the active chat. Call after a session-switch
 *  finishes (the store mutations may have run while a different chat
 *  was viewed, so the subscriber skipped them). */
export function rerenderActive(): void {
  const chatId = getViewedChatId();
  if (!chatId) return;
  rerenderInto(chatId);
}

function ensureVirtualizer(el: HTMLElement): void {
  if (virtualizer) return;
  virtualizer = bindVirt({
    transcriptEl: el,
    // The reconciler doesn't care whether it's writing into the
    // full transcript element or the virtualizer's slot — it just
    // diffs against children of whatever element it's given. Same
    // contract, smaller parent.
    //
    // `batchBubbles: true` suppresses chat.addLine's per-bubble
    // autoScroll. Under virt the window shifts during touch-scroll;
    // each new bubble's autoScroll would re-check pinnedToBottom and
    // snap the page back to bottom. Field bug 2026-05-25 (Jonathan,
    // mobile PWA): "scroll moves a little, then pops back" — the
    // reconciler's per-create autoScroll fired dozens of times per
    // finger move. Default path (reconcile called directly on
    // #transcript from streaming/durable updates) leaves this flag
    // off and gets the legacy per-bubble follow-along.
    renderWindow: (slotEl, specs) => { reconcile(slotEl, specs, { batchBubbles: true }); },
  });
}

function rerenderInto(chatId: string): void {
  const el = getTranscriptEl();
  if (!el) return;
  const specs = project(getState(chatId));
  if (isVirtualizerEnabled()) {
    ensureVirtualizer(el);
    virtualizer!.setSpecs(specs);
  } else {
    reconcile(el, specs);
  }
  // Switch-then-load: the row-click handler sets .transcript-loading
  // synchronously when flipping focus to a new chat. Clear it as soon
  // as the first non-empty render lands so the spinner disappears
  // when content arrives (whether from cache or server).
  if (specs.length > 0) el.classList.remove('transcript-loading');
  scheduleSnapshotPersist();
}

// Re-export the public surface from neighboring modules so call sites
// only need to import from './transcript'.
export { project } from './projection.ts';
export { reconcile } from './reconciler.ts';
export * as store from './store.ts';
export type * from './types.ts';
