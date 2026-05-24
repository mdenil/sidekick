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
import { scheduleSnapshotPersist } from '../chat.ts';
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
 *  rendering. Checks `localStorage['sidekick.virtualize']` first
 *  (sticky across reloads — what most users will set), then URL
 *  param `?virt=1` (one-shot, for dev iteration). The flag is read
 *  ONCE per session at first-render time; toggling it mid-session
 *  requires a reload. */
export function isVirtualizerEnabled(): boolean {
  try {
    if (typeof window !== 'undefined') {
      if (window.localStorage?.getItem('sidekick.virtualize') === '1') return true;
      if (new URLSearchParams(window.location.search).get('virt') === '1') return true;
    }
  } catch { /* SSR / privacy mode — flag off */ }
  return false;
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
    renderWindow: (slotEl, specs) => { reconcile(slotEl, specs); },
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
  scheduleSnapshotPersist();
}

// Re-export the public surface from neighboring modules so call sites
// only need to import from './transcript'.
export { project } from './projection.ts';
export { reconcile } from './reconciler.ts';
export * as store from './store.ts';
export type * from './types.ts';
