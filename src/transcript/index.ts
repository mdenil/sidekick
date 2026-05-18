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

let getTranscriptEl: () => HTMLElement | null = () => document.getElementById('transcript');
let getViewedChatId: () => string | null = () => null;

export interface BindOpts {
  transcriptEl: () => HTMLElement | null;
  getViewedChatId: () => string | null;
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

function rerenderInto(chatId: string): void {
  const el = getTranscriptEl();
  if (!el) return;
  reconcile(el, project(getState(chatId)));
}

// Re-export the public surface from neighboring modules so call sites
// only need to import from './transcript'.
export { project } from './projection.ts';
export { reconcile } from './reconciler.ts';
export * as store from './store.ts';
export type * from './types.ts';
