/**
 * @fileoverview Treats the composer textarea as a dictation target.
 *
 * When `autoSend` is off, STT finals land here (at the cursor position,
 * like mainstream chat apps) instead of into a separate draft block in
 * the transcript. The user mixes typed + dictated text freely and sends
 * via the same send button they'd use for typed messages.
 *
 * Interim text (non-final STT output) shows as a small ghost line just
 * below the composer — feedback that the mic is alive without polluting
 * the committed text.
 *
 * Why a shell module (not draft.ts): draft.ts owns a distinct DOM surface
 * in the transcript area and has its own segment-tracking for gap
 * backfill splice. The composer is a plain <textarea> — different affordance,
 * different lifecycle (cleared on send, not flushed via onFlush). Keeping
 * them separate avoids forcing one to grow the other's complexity.
 */

import { diag } from './util/log.ts';

let inputEl: HTMLTextAreaElement | null = null;
let interimEl: HTMLElement | null = null;
let onChange = () => {};
let onSubmit = () => {};

/** Last cursor position the user explicitly set in the composer textarea
 *  while it was focused. Updated by a global selectionchange listener
 *  that fires only when the textarea is the active element — so it
 *  captures every arrow-key / mouse / API-driven caret move WHILE the
 *  textarea is engaged, and survives the inevitable focus shift to the
 *  mic button at gesture time.
 *
 *  Why we need this: at mic-button pointerdown, captureComposerCursor()
 *  in main.ts reads composerInput.selectionStart. On at least some
 *  browser/state combinations (notably: button mousedown → focus shift
 *  before our pointerdown handler runs), that read returns 0 or stale
 *  values for the just-blurred textarea — even though the user can SEE
 *  the cursor where they put it. The cache is the user's intent. */
let lastKnownCaret: number | null = null;

export function init(opts: {
  input: HTMLTextAreaElement | null,
  interim?: HTMLElement | null,
  onChange?: () => void,
  onSubmit?: () => void,
}) {
  inputEl = opts.input;
  interimEl = opts.interim ?? null;
  if (opts.onChange) onChange = opts.onChange;
  if (opts.onSubmit) onSubmit = opts.onSubmit;

  // Emacs-style Ctrl-K: cut from cursor to end of current line.
  // Ctrl+K is reserved for this on Mac (Cmd+K opens search instead).
  // On non-Mac platforms Ctrl+K still opens search (handled in
  // cmdkPalette.ts), so this handler also gates on !metaKey.
  if (inputEl) {
    // Track caret position whenever the user moves it within the
    // (focused) textarea. selectionchange fires on document; gate to
    // our textarea via activeElement.
    document.addEventListener('selectionchange', () => {
      if (!inputEl) return;
      if (document.activeElement !== inputEl) return;
      const ss = inputEl.selectionStart;
      if (typeof ss === 'number') lastKnownCaret = ss;
    });

    inputEl.addEventListener('keydown', (e) => {
      if (e.ctrlKey && !e.metaKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        const el = inputEl!;
        const val = el.value;
        const start = el.selectionStart ?? 0;
        // Find end of current line (next \n or end of value).
        const lineEnd = val.indexOf('\n', start);
        const end = lineEnd === -1 ? val.length : lineEnd;
        // If at EOL with content after (newline immediately at cursor),
        // delete the newline itself — joins the next line up. Matches
        // Emacs/readline behaviour.
        const cutEnd = (start === end && lineEnd !== -1) ? end + 1 : end;
        const cut = val.slice(start, cutEnd);
        if (!cut) return;
        // Best-effort clipboard write (may be denied on non-secure
        // contexts or by user agent). Either way, perform the cut.
        if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(cut).catch(() => {});
        }
        el.value = val.slice(0, start) + val.slice(cutEnd);
        el.setSelectionRange(start, start);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        onChange();
      }
    });
  }
}

/** Submit the composer's current content (same path as clicking send /
 *  pressing Enter). Wired by main.ts to sendTypedMessage so the voice
 *  pipeline's auto-submit-on-silence loop fires the single send codepath. */
export function submit() { onSubmit(); }

/** Last user-set caret position in the textarea, captured via a
 *  selectionchange listener while the textarea was focused. Returns
 *  null until the user has moved the caret at least once.  Used by
 *  captureComposerCursor() at the mic-button gesture site as a robust
 *  fallback for live selectionStart reads that go stale post-blur. */
export function getLastCaret(): number | null { return lastKnownCaret; }

/** Append dictation final at the cursor position. Adds a leading space if
 *  the cursor is right after a non-whitespace character, so words don't
 *  concatenate ("hellohow" → "hello how"). Dispatches 'input' so the
 *  auto-resize + send-button-state listeners fire as if the user typed. */
export function appendText(text: string) {
  if (!inputEl) return;
  const t = text.trim();
  if (!t) return;

  const val = inputEl.value;
  const start = inputEl.selectionStart ?? val.length;
  const end = inputEl.selectionEnd ?? val.length;
  const before = val.slice(0, start);
  const after = val.slice(end);

  // Smart spacing: leading space if the char before cursor is non-whitespace;
  // trailing space so the next dictation or typed char is naturally separated.
  const needLead = before.length > 0 && !/\s$/.test(before);
  const needTrail = after.length > 0 && !/^\s/.test(after);
  const insert = (needLead ? ' ' : '') + t + (needTrail ? ' ' : ' ');

  inputEl.value = before + insert + after;
  const newPos = before.length + insert.length;
  inputEl.setSelectionRange(newPos, newPos);
  // Fire input event so autoResize + updateSendButtonState react.
  inputEl.dispatchEvent(new Event('input', { bubbles: true }));
  clearInterim();
  onChange();
  diag('composer append:', JSON.stringify({ len: t.length, text: t.slice(0, 60) }));
}

/** Show an interim (non-final) STT preview just below the composer. No-op
 *  if the interim element isn't wired (inline preview is optional). */
export function setInterim(text: string) {
  if (!interimEl) return;
  const t = text.trim();
  if (!t) { clearInterim(); return; }
  interimEl.textContent = t;
  interimEl.classList.add('active');
}

export function clearInterim() {
  if (!interimEl) return;
  interimEl.textContent = '';
  interimEl.classList.remove('active');
}

/** True if the composer has any user-visible content. Used by voice.ts to
 *  skip speaker prefixes + paragraph breaks on an empty composer. */
export function hasContent(): boolean {
  return !!(inputEl && inputEl.value.length > 0);
}
