/**
 * @fileoverview Select text in the transcript → floating "Quote" button →
 * insert the selection as a markdown blockquote into the composer for reply.
 *
 * Why roll our own (no lib): the affordance is a single floating button
 * positioned off the selection rect. A library would drag in toolbar
 * chrome, theming, and a config surface we don't want.
 *
 * iOS reality: the native selection callout (Copy / Look Up) appears ABOVE
 * the selection and CANNOT be extended from web. We float our own button
 * BELOW the selection so it doesn't fight the callout. Show on
 * pointerup/touchend (after a tick so the selection has settled — and a
 * little longer on touch so the magnifier/callout animation finishes);
 * hide when the selection collapses, on scroll, and on resize.
 *
 * Gate: only fire for selections that live inside the transcript element,
 * so selecting composer text or UI chrome doesn't pop the button.
 */

import { diag } from './util/log.ts';

let transcriptEl: HTMLElement | null = null;
let onQuote: (text: string) => void = () => {};
let fab: HTMLButtonElement | null = null;
// The selected text captured at show-time. The button's pointerdown reads
// THIS, not a live getSelection() — by the time the button is pressed on
// iOS the selection may already be collapsing.
let capturedText = '';

export function init(opts: {
  transcriptEl: HTMLElement | null,
  onQuote: (text: string) => void,
}) {
  transcriptEl = opts.transcriptEl;
  onQuote = opts.onQuote;
  if (!transcriptEl) return;

  fab = document.createElement('button');
  fab.className = 'quote-fab';
  fab.type = 'button';
  // Slack-style blockquote glyph: a left vertical rail + three horizontal
  // lines. Icon alone reads as ambiguous on a novel floating button, so it's
  // paired with the word.
  fab.innerHTML =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
    'stroke-linecap="round" aria-hidden="true">' +
    '<path d="M2.5 4v8"/><path d="M6 4.5h7.5"/><path d="M6 8h7.5"/><path d="M6 11.5h7.5"/>' +
    '</svg><span>Quote</span>';
  fab.setAttribute('aria-label', 'Quote selection into reply');
  fab.style.display = 'none';
  // pointerdown (not click): on iOS a click arrives after the selection has
  // already collapsed and the magnifier dismissed. preventDefault keeps the
  // press from collapsing the selection / blurring before we read it.
  fab.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const text = capturedText;
    hide();
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    if (text) {
      onQuote(text);
      diag('select-to-quote:', JSON.stringify({ len: text.length }));
    }
  });
  document.body.appendChild(fab);

  // Show after the selection settles. setTimeout(0) lets the browser
  // finalize the range; touch gets a longer delay so iOS's magnifier and
  // callout have stopped animating (positioning against a moving rect
  // produces a button that jumps).
  document.addEventListener('mouseup', () => setTimeout(maybeShow, 0));
  document.addEventListener('touchend', () => setTimeout(maybeShow, 300));

  // Collapse → hide. selectionchange fires on every caret move; only react
  // when the selection became empty (the user dismissed it).
  document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) hide();
  });

  // The button is position:fixed against a selection rect; scrolling or
  // resizing invalidates that rect, so just hide rather than chase it.
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}

function selectionInTranscript(sel: Selection): boolean {
  if (!transcriptEl || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return !!el && transcriptEl.contains(el);
}

function maybeShow() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) { hide(); return; }
  const text = sel.toString().trim();
  if (!text) { hide(); return; }
  if (!selectionInTranscript(sel)) { hide(); return; }
  capturedText = text;
  position(sel.getRangeAt(0).getBoundingClientRect());
}

function position(rect: DOMRect) {
  if (!fab) return;
  // Make it measurable before reading its size.
  fab.style.display = 'block';
  const fw = fab.offsetWidth;
  const fh = fab.offsetHeight;
  const gap = 8;
  // Below the selection (native callout sits above), horizontally centered
  // on the selection, clamped into the viewport.
  let top = rect.bottom + gap;
  let left = rect.left + rect.width / 2 - fw / 2;
  if (top + fh > window.innerHeight - gap) top = rect.top - fh - gap;
  left = Math.max(gap, Math.min(left, window.innerWidth - fw - gap));
  fab.style.top = `${Math.round(top)}px`;
  fab.style.left = `${Math.round(left)}px`;
}

function hide() {
  if (fab) fab.style.display = 'none';
  capturedText = '';
}
