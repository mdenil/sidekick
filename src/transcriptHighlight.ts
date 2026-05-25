/**
 * @fileoverview Keyboard-driven message-highlight mode for the
 * transcript. Slack-style:
 *
 *   • Composer EMPTY + ↑ → enter highlight mode, highlight the most
 *     recent message, scroll it into view.
 *   • ↑ / ↓ — move highlight to prev / next message.
 *   • ↓ past the most recent message → exit highlight mode, return
 *     focus to the composer.
 *   • Esc → exit highlight mode.
 *   • p — toggle pin on the highlighted message.
 *   • c — copy the highlighted message's text to the clipboard.
 *
 * Sole entry point is the composer's `keydown` handler at the start
 * of every keystroke. Highlight state lives in module scope so the
 * composer's keyup / blur don't accidentally lose it.
 *
 * The highlight visual is a dedicated `.transcript-highlight` class
 * on the bubble so it stacks cleanly over the existing
 * `.search-target-flash` styles without color collisions.
 */

import { log } from './util/log.ts';
import {
  isPinned as isPinMsg,
  pinMessage,
  unpinMessage,
} from './pins/store.ts';
import * as backend from './backend.ts';
import { getVirtualizer } from './transcript/index.ts';

let composerEl: HTMLTextAreaElement | null = null;
let transcriptEl: HTMLElement | null = null;
let highlightedEl: HTMLElement | null = null;
/** Under virtualization, the highlighted bubble may scroll out of the
 *  visible window and unmount. We track its KEY (BubbleSpec.key) so
 *  navigation can find it again via `virtualizer.scrollToKey`. The
 *  legacy default path (when virt is off) walks DOM directly and
 *  leaves this null. */
let highlightedKey: string | null = null;
let hintEl: HTMLElement | null = null;

function bubbles(): HTMLElement[] {
  if (!transcriptEl) return [];
  return Array.from(
    transcriptEl.querySelectorAll<HTMLElement>(
      '.line[data-message-id]:not(.pending):not(.failed)',
    ),
  );
}

/** Under virtualization, return the full navigable key list from the
 *  virtualizer (user + assistant bubbles, full chat). Falls back to
 *  null when no virtualizer is active — callers use the legacy
 *  bubbles() walk. */
function navigableKeysViaVirt(): string[] | null {
  const v = getVirtualizer();
  if (!v) return null;
  return v.getKeys({ navigable: true });
}

/** Find a `.line[data-key=KEY]` element in the transcript, or null
 *  if outside the rendered window. Used after a `scrollToKey` call to
 *  pick up the now-mounted bubble. */
function findByKey(key: string): HTMLElement | null {
  if (!transcriptEl) return null;
  return transcriptEl.querySelector<HTMLElement>(
    `.line[data-key="${CSS.escape(key)}"]`,
  );
}

function ensureHint(): void {
  if (hintEl || typeof document === 'undefined') return;
  const el = document.createElement('div');
  el.className = 'transcript-highlight-hint';
  el.setAttribute('aria-hidden', 'true');
  // Each segment is a separate <span> so CSS can dim the bullets
  // between them without dimming the key glyphs.
  el.innerHTML =
    '<kbd>↑↓</kbd> navigate'
    + '<span class="thh-sep">·</span><kbd>P</kbd> pin'
    + '<span class="thh-sep">·</span><kbd>C</kbd> copy'
    + '<span class="thh-sep">·</span><kbd>Esc</kbd> exit';
  document.body.appendChild(el);
  hintEl = el;
}

/** Position the hint chip just above the currently highlighted bubble.
 *  Field UX 2026-05-16 (Jonathan): the fixed bottom-center placement
 *  overlapped the composer. Anchor to the bubble instead so the chip
 *  moves with the selection and stays out of the input area. */
function positionHint(): void {
  if (!hintEl) return;
  const bubble = highlightedEl;
  if (!bubble) return;
  const rect = bubble.getBoundingClientRect();
  // Above the bubble with 6px gap. If the bubble is near the top of
  // the viewport, the chip would clip — fall back to below it.
  const chipH = 28;  // approx height of the rendered chip; CSS sets ~26-30
  const gap = 6;
  const above = rect.top - chipH - gap;
  const useAbove = above > 12;  // give it 12px from viewport top
  const y = useAbove ? above : rect.bottom + gap;
  // Center horizontally on the bubble's mid-width.
  const x = rect.left + rect.width / 2;
  hintEl.style.left = `${Math.round(x)}px`;
  hintEl.style.top = `${Math.round(y)}px`;
}

function showHint(): void {
  ensureHint();
  positionHint();
  hintEl?.classList.add('visible');
}

function hideHint(): void {
  hintEl?.classList.remove('visible');
}

function setHighlight(el: HTMLElement | null): void {
  if (highlightedEl && highlightedEl !== el) {
    highlightedEl.classList.remove('transcript-highlight');
  }
  highlightedEl = el;
  highlightedKey = el?.getAttribute('data-key') || null;
  if (el) {
    el.classList.add('transcript-highlight');
    // Reposition the chip AFTER scroll completes; smooth scroll is
    // animated, so the bubble rect changes over ~300ms. Position once
    // immediately (so the chip appears next to the pre-scroll position)
    // and once after the scroll settles.
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    showHint();
    setTimeout(() => { if (highlightedEl === el) positionHint(); }, 320);
  } else {
    hideHint();
  }
}

/** Highlight the bubble for `key`, scrolling the virtualizer's
 *  window so the bubble mounts if needed. Used under virt by ↑↓
 *  navigation that might cross slot boundaries. */
function setHighlightByKey(key: string): void {
  const existing = findByKey(key);
  if (existing) {
    setHighlight(existing);
    return;
  }
  const v = getVirtualizer();
  if (!v) return;
  v.scrollToKey(key, { block: 'center' });
  // Two rAF ticks: one for the virtualizer's rerender, one for the
  // resulting layout pass that mounts the bubble in DOM.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const el = findByKey(key);
    if (el) setHighlight(el);
  }));
}

function exitHighlight(): void {
  if (highlightedEl) highlightedEl.classList.remove('transcript-highlight');
  highlightedEl = null;
  highlightedKey = null;
  hideHint();
  composerEl?.focus();
}

/** Called by external state-change paths (chat switch, new chat) to
 *  drop highlight mode without focusing the composer. Idempotent.
 *  Field UX 2026-05-16 (Jonathan): "when i go into select mode and
 *  then switch sessions or do new chat this overlay should disappear
 *  but it doesn't." */
export function clearHighlight(): void {
  if (!highlightedEl) {
    hideHint();
    return;
  }
  highlightedEl.classList.remove('transcript-highlight');
  highlightedEl = null;
  hideHint();
}

/** True if the composer's textarea has no user content. Empty +
 *  whitespace-only count as empty so a stray space doesn't block
 *  the gesture. */
function composerIsEmpty(): boolean {
  if (!composerEl) return false;
  return !composerEl.value || composerEl.value.trim() === '';
}

function move(delta: 1 | -1): void {
  // Under virtualization, walk the full key set from the virtualizer
  // — only the visible window is in DOM, so the legacy bubbles()
  // approach would treat the slot's edges as the chat's edges. The
  // virtualizer's getKeys() returns every navigable spec in order
  // regardless of mount state; scrollToKey expands the window when
  // we cross the slot boundary.
  const virtKeys = navigableKeysViaVirt();
  if (virtKeys) {
    if (virtKeys.length === 0) return;
    const idx = highlightedKey ? virtKeys.indexOf(highlightedKey) : -1;
    const next = idx < 0
      ? (delta === -1 ? virtKeys.length - 1 : 0)
      : idx + delta;
    if (next < 0) {
      setHighlightByKey(virtKeys[0]);
      return;
    }
    if (next >= virtKeys.length) {
      exitHighlight();
      return;
    }
    setHighlightByKey(virtKeys[next]);
    return;
  }
  // Legacy default-path walk — full chat is in DOM, indexOf works.
  const list = bubbles();
  if (list.length === 0) return;
  const idx = highlightedEl ? list.indexOf(highlightedEl) : -1;
  const next = idx < 0
    ? (delta === -1 ? list.length - 1 : 0)
    : idx + delta;
  if (next < 0) {
    setHighlight(list[0]);
    return;
  }
  if (next >= list.length) {
    exitHighlight();
    return;
  }
  setHighlight(list[next]);
}

async function togglePinOnHighlight(): Promise<void> {
  if (!highlightedEl) return;
  const msgId = highlightedEl.dataset.messageId || '';
  if (!msgId) return;
  const chatId = backend.getCurrentSessionId?.() || null;
  if (!chatId) return;
  if (isPinMsg(chatId, msgId)) {
    await unpinMessage(chatId, msgId);
    highlightedEl.classList.remove('pinned');
    const btn = highlightedEl.querySelector('.pin-btn');
    btn?.classList.remove('pinned');
  } else {
    const text = highlightedEl.dataset.text
      || (highlightedEl.querySelector('.text') as HTMLElement | null)?.textContent
      || '';
    const preview = text.length > 16000 ? text.slice(0, 15997) + '…' : text;
    const cls = highlightedEl.className;
    const role = cls.includes('agent') ? 'assistant'
      : cls.includes('system') ? 'system' : 'user';
    await pinMessage({ chatId, msgId, role, text: preview, timestamp: Date.now() });
    highlightedEl.classList.add('pinned');
    const btn = highlightedEl.querySelector('.pin-btn');
    btn?.classList.add('pinned');
  }
  log(`[transcript-highlight] toggle pin on ${msgId}`);
}

async function copyHighlight(): Promise<void> {
  if (!highlightedEl) return;
  const text = highlightedEl.dataset.text
    || (highlightedEl.querySelector('.text') as HTMLElement | null)?.textContent
    || '';
  if (!text) return;
  try { await navigator.clipboard.writeText(text); } catch { /* clipboard might be unavailable */ }
}

export function initTranscriptHighlight(opts: {
  composer: HTMLTextAreaElement | null;
  transcript: HTMLElement | null;
}): void {
  composerEl = opts.composer;
  transcriptEl = opts.transcript;
  if (!composerEl || !transcriptEl) {
    log('[transcript-highlight] required DOM missing — disabled');
    return;
  }

  // Composer keydown: empty + Up enters highlight mode.
  composerEl.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'ArrowUp') return;
    // Modifier keys passthrough — only bare Up engages the gesture.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!composerIsEmpty()) return;
    if (highlightedEl) return;  // already in highlight mode
    e.preventDefault();
    // Under virt: start at the most recent navigable spec (chat tail).
    const virtKeys = navigableKeysViaVirt();
    if (virtKeys) {
      if (virtKeys.length === 0) return;
      setHighlightByKey(virtKeys[virtKeys.length - 1]);
      return;
    }
    const list = bubbles();
    if (list.length === 0) return;
    setHighlight(list[list.length - 1]);   // most recent bubble
  });

  // Global keydown — only acts when we're in highlight mode.
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (!highlightedEl) return;
    // Modifier keys pass through (Cmd+P should remain print, etc.).
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Don't steal keys from other inputs that may be focused (cmdk,
    // settings inputs). Only the composer + transcript surface are
    // ours.
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName?.toUpperCase() || '';
    if (tag === 'INPUT' || (tag === 'TEXTAREA' && t !== composerEl) || t?.isContentEditable) {
      // Allow composer up-arrow to bubble back through, since
      // composer's own listener handles enter/exit on the empty
      // path. Below handles in-mode navigation.
      if (t !== composerEl) return;
    }
    if (e.key === 'Escape') { e.preventDefault(); exitHighlight(); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); move(-1); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1);  return; }
    if (e.key === 'p' || e.key === 'P') { e.preventDefault(); void togglePinOnHighlight(); return; }
    if (e.key === 'c' || e.key === 'C') { e.preventDefault(); void copyHighlight(); return; }
    if (e.key === 'Enter') { e.preventDefault(); exitHighlight(); return; }
  });
}
