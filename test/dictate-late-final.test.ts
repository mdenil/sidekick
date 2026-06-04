/**
 * @fileoverview Regression test for the post-abandon late-final
 * duplication bug logged 2026-05-07.
 *
 * Repro from the field log (timestamps 20:50:36 etc.):
 *   1. User dictates an utterance — interim splices into textarea.
 *   2. User clicks elsewhere (or types) BEFORE the bridge sends the
 *      matching final → onUserSelectionChange / onUserInput fires
 *      resetUtterance, anchor=null.
 *   3. The late final arrives. Without suppression, handleContentFinal
 *      ran ensureAnchor() (captures the user's NEW caret) and spliced
 *      the same words there → text appears at BOTH the abandoned
 *      location AND the new caret. Three or four copies if the user
 *      kept clicking around.
 *
 * The fix tracks `abandonedAt` (timestamp of last user-driven reset)
 * and drops STT events arriving within ABANDON_SUPPRESS_MS so they
 * can't re-anchor at the latest caret position.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type {
  STTProvider,
  TranscriptEvent,
  Unsubscribe,
} from '../src/audio/shared/stt-provider.ts';

// ── Browser-ish globals — stub before importing dictate.ts ────────────

(globalThis as any).window = (globalThis as any).window || {};
(globalThis as any).location = (globalThis as any).location || { search: '' };
(globalThis as any).localStorage = (globalThis as any).localStorage || {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

// Document stub — dictate.ts does:
//   document.addEventListener('selectionchange', onUserSelectionChange)
//   if (document.activeElement !== composerInput) return
//   document.documentElement.classList.contains('capacitor-app')
//     (Cap platform gate added 2026-05-09 for the iOS keyboard race fix —
//      stub the classList as a static no-Cap browser; the test never
//      exercises the Cap branch.)
const docListeners: Record<string, Array<(ev: any) => void>> = {};
let activeElementRef: any = null;
(globalThis as any).document = {
  addEventListener: (type: string, fn: (ev: any) => void) => {
    (docListeners[type] ||= []).push(fn);
  },
  removeEventListener: (type: string, fn: (ev: any) => void) => {
    const list = docListeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
  get activeElement() { return activeElementRef; },
  documentElement: {
    classList: {
      contains: (_cls: string) => false,
    },
  },
};

// Event stub — dictate.ts dispatches `new Event('input', { bubbles: true })`.
class FakeEvent {
  type: string;
  constructor(type: string, _opts?: any) { this.type = type; }
}
(globalThis as any).Event = FakeEvent;

// ── Fake textarea ──────────────────────────────────────────────────────

class FakeTextarea {
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  // Generalized listener bag — dictate.init now registers both `input`
  // and `focus` (the latter added 2026-05-10 for the iOS keyboard race
  // fix). Originally this was a typed `{ input: [] }` literal; that
  // broke when `focus` came along, undefined-pushing on init.
  private _listeners: Record<string, Array<(ev: any) => void>> = {};
  addEventListener(type: string, fn: (ev: any) => void) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  }
  removeEventListener(type: string, fn: (ev: any) => void) {
    const list = this._listeners[type];
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  setRangeText(text: string, start: number, end: number, _mode: string) {
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
  }
  setSelectionRange(start: number, end: number) {
    this.selectionStart = start;
    this.selectionEnd = end;
    // Real DOM fires selectionchange on document; mirror that so the
    // dictate listener sees it (gated by activeElement check).
    queueMicrotask(() => {
      const list = docListeners['selectionchange'];
      if (!list) return;
      for (const fn of list) fn({});
    });
  }
  dispatchEvent(ev: any) {
    const list = this._listeners[ev.type];
    if (!list) return;
    for (const fn of list) fn(ev);
  }
  focus(_opts?: any) {
    activeElementRef = this;
  }
}

// ── Mock STT provider ──────────────────────────────────────────────────

class MockSTTProvider implements STTProvider {
  private listeners: Array<(ev: TranscriptEvent) => void> = [];
  private started = false;
  startOpts: { sessionId?: string | null; chatId?: string | null } | undefined;
  async start(opts?: { sessionId?: string | null; chatId?: string | null }) {
    this.startOpts = opts;
    this.started = true;
  }
  async stop() { this.started = false; }
  onTranscript(cb: (ev: TranscriptEvent) => void): Unsubscribe {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  emit(ev: TranscriptEvent) {
    if (!this.started) throw new Error('emit before start');
    for (const fn of this.listeners) fn(ev);
  }
}

// Import after globals are stubbed.
import * as dictate from '../src/audio/realtime/dictate.ts';

// ── Helpers ────────────────────────────────────────────────────────────

function userInterim(provider: MockSTTProvider, text: string) {
  provider.emit({ type: 'transcript', role: 'user', is_final: false, text });
}
function userFinal(provider: MockSTTProvider, text: string) {
  provider.emit({ type: 'transcript', role: 'user', is_final: true, text });
}

// Count occurrences of a substring in the textarea — the bug's signature
// is that an utterance ends up in the textarea TWICE.
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('dictate — late final after user-driven reset', () => {
  let textarea: FakeTextarea;
  let provider: MockSTTProvider;

  beforeEach(async () => {
    textarea = new FakeTextarea();
    activeElementRef = textarea;  // simulate composer focused
    dictate.init(textarea as unknown as HTMLTextAreaElement);
    provider = new MockSTTProvider();
    await dictate.start({ initialCursor: 0, provider });
  });
  afterEach(async () => {
    await dictate.stop();
    activeElementRef = null;
  });

  it('drops a late final after onUserSelectionChange reset (the bug)', async () => {
    // User dictates the start of an utterance — interim splices in.
    userInterim(provider, 'Okay. That was a duplicate. That\'s better. Is');
    assert.equal(textarea.value, 'Okay. That was a duplicate. That\'s better. Is');

    // Pre-populate some unrelated text so the user can click outside
    // the utterance range.  In the real bug the textarea already had
    // earlier committed content; here we just append.
    textarea.value += '\n\n--- end of utterance ---\nclicking somewhere new here:';
    const newCursor = textarea.value.length;
    textarea.selectionStart = newCursor;
    textarea.selectionEnd = newCursor;

    // Fire selectionchange synchronously (not via setSelectionRange,
    // which would be the dictate module's own write).
    const list = docListeners['selectionchange'];
    if (list) for (const fn of list) fn({});

    // The bridge now delivers the final for the abandoned utterance —
    // its text is a SUBSET of the interim because the user moved on
    // mid-utterance and Deepgram only had the first sentence finalised.
    const valueBeforeLateFinal = textarea.value;
    userFinal(provider, 'Okay. That was a duplicate.');

    // Without the fix: "Okay. That was a duplicate." would be spliced
    // at newCursor, yielding TWO occurrences (one in the interim that's
    // still in the textarea, one freshly inserted at the new caret).
    // With the fix: the late final is dropped, textarea is unchanged.
    assert.equal(
      textarea.value,
      valueBeforeLateFinal,
      'late final should not modify the textarea after a user-driven reset',
    );
    assert.equal(
      countOccurrences(textarea.value, 'Okay. That was a duplicate.'),
      1,
      'utterance text should appear exactly once',
    );
  });

  it('passes chatId through to the STT provider on start', async () => {
    await dictate.stop();
    provider = new MockSTTProvider();
    await dictate.start({
      sessionId: 'sidekick:test-chat',
      chatId: 'sidekick:test-chat',
      initialCursor: 0,
      provider,
    });
    assert.deepEqual(provider.startOpts, {
      sessionId: 'sidekick:test-chat',
      chatId: 'sidekick:test-chat',
    });
  });

  it('drops a late final after onUserInput reset', async () => {
    userInterim(provider, 'Hello world from voice.');
    assert.equal(textarea.value, 'Hello world from voice.');

    // Simulate the user typing — append a char and dispatch input.
    textarea.value += 'X';
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;
    textarea.dispatchEvent({ type: 'input' });

    const valueBeforeLateFinal = textarea.value;
    userFinal(provider, 'Hello world from voice.');
    assert.equal(textarea.value, valueBeforeLateFinal);
  });

  it('also drops late interims (Deepgram can revise post-reset)', async () => {
    userInterim(provider, 'First utterance partial');
    textarea.value += '\n[user clicks elsewhere]';
    const newCursor = textarea.value.length;
    textarea.selectionStart = newCursor;
    textarea.selectionEnd = newCursor;
    const list = docListeners['selectionchange'];
    if (list) for (const fn of list) fn({});

    const before = textarea.value;
    // Late interim revising the same utterance — must not splice at new caret.
    userInterim(provider, 'First utterance partial revised');
    assert.equal(textarea.value, before);
  });

  it('strict cursor-match: cursor move WITHIN the utterance range still resets (bug 2026-05-07)', () => {
    // Repro: utterance covers the whole textarea (anchor=0, content=
    // "Hello world."). User arrows to mid-text. Old heuristic said
    // "pos in [0, 12], no reset" → next utterance kept appending at
    // end. New gate: pos !== lastSetCursor → reset.
    userInterim(provider, 'Hello world.');
    userFinal(provider, 'Hello world.');
    assert.equal(textarea.value, 'Hello world.');
    // setCursor() landed lastSetCursor at 12 (end of "Hello world.").
    // Simulate user arrowing to position 5 — INSIDE the utterance.
    activeElementRef = textarea;
    textarea.selectionStart = 5;
    textarea.selectionEnd = 5;
    const list = docListeners['selectionchange'];
    if (list) for (const fn of list) fn({});
    // The old in-range heuristic would have ignored this. With the
    // strict-match fix, anchor is now null and the next interim
    // captures fresh at user's caret.
    userInterim(provider, 'Inserted mid-text');
    // Should have spliced "Inserted mid-text" starting at position 5,
    // not at the end. Verify by checking the inserted text is
    // BEFORE the original "world.".
    const insertIdx = textarea.value.indexOf('Inserted');
    const worldIdx = textarea.value.indexOf('world');
    assert.ok(insertIdx >= 0, 'inserted text should appear in textarea');
    assert.ok(insertIdx < worldIdx, 'insert should land before "world", not at end');
  });

  it('content-aware suppression lets new utterances through within the time window', async () => {
    // Repro: user abandons utterance "Hello world", then within the
    // 2500ms window says a NEW utterance "Goodbye now". Time-only
    // suppression would drop "Goodbye now" too (same window). Content
    // matching: prefix "Goodbye " differs from "Hello wo" → not dropped.
    userInterim(provider, 'Hello world');
    activeElementRef = textarea;
    textarea.value += '\n[click outside]';
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.selectionStart;
    const list = docListeners['selectionchange'];
    if (list) for (const fn of list) fn({});

    // Within 500ms of the reset — well inside the 2500ms window.
    userInterim(provider, 'Goodbye now');
    userFinal(provider, 'Goodbye now');
    assert.ok(
      textarea.value.includes('Goodbye now'),
      'genuinely-new utterance within the window should NOT be suppressed',
    );
  });

  it('does not interfere with happy-path dictation (no resets)', async () => {
    userInterim(provider, 'Hello');
    userInterim(provider, 'Hello world');
    userFinal(provider, 'Hello world');
    assert.equal(textarea.value, 'Hello world');
    assert.equal(countOccurrences(textarea.value, 'Hello world'), 1);
  });

  it('re-anchors when the buffer shifts under a live anchor without a fired event (the dupe bug)', () => {
    // Repro the reported "duplicate of the chunk between old and new
    // cursor" bug. On iOS WKWebView a user edit / caret move can be
    // coalesced or arrive as a composition/autocorrect mutation that
    // never fires a plain `input`/`selectionchange`. The anchor stays
    // live but the textarea content has shifted, so the next splice
    // would overwrite the WRONG span — corrupting the front and leaving
    // a duplicate.
    userInterim(provider, 'Hello world');
    assert.equal(textarea.value, 'Hello world');

    // Simulate a content shift dictate NEVER observed: prepend text and
    // move the caret to the end, WITHOUT dispatching input/selectionchange.
    textarea.value = 'PREFIX ' + textarea.value; // "PREFIX Hello world"
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;

    // Next interim arrives. The anchor (0) + interimLen (11) range now
    // holds "PREFIX Hell" — NOT the "Hello world" we wrote. The guard
    // must detect the desync, reset, and re-anchor at the live caret.
    userInterim(provider, 'Hello world today');

    // Front is intact (no corruption), original interim untouched, and
    // the new utterance landed at the user's caret with a word-break.
    assert.equal(
      textarea.value,
      'PREFIX Hello world Hello world today',
      'stale anchor must be re-synced; the front of the buffer must not be overwritten',
    );
  });

  it('does not re-anchor spuriously when the buffer is intact (no false positives)', () => {
    // The guard must be a no-op on the happy path: interim → interim →
    // final with no external mutation should track cleanly, never
    // tripping resyncIfAnchorStale.
    userInterim(provider, 'The quick');
    userInterim(provider, 'The quick brown fox');
    userFinal(provider, 'The quick brown fox');
    assert.equal(textarea.value, 'The quick brown fox');
    assert.equal(countOccurrences(textarea.value, 'The quick brown fox'), 1);
    // A follow-on utterance in the same session continues correctly.
    userInterim(provider, 'jumps over');
    userFinal(provider, 'jumps over');
    assert.equal(countOccurrences(textarea.value, 'jumps over'), 1);
  });

  it('suppression window expires — new utterance after grace lands normally', async () => {
    userInterim(provider, 'First utterance.');
    // Trigger user-driven reset.
    textarea.selectionStart = textarea.value.length + 1;
    textarea.selectionEnd = textarea.selectionStart;
    // We need the cursor to be OUTSIDE the utterance range to trigger
    // user-cursor-outside.  Append a char to the textarea so there's
    // somewhere outside to be.
    textarea.value += ' ';
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.selectionStart;
    const list = docListeners['selectionchange'];
    if (list) for (const fn of list) fn({});

    // Wait past the suppression window (2500ms) — use 2600ms to avoid
    // flakiness on slow CI.
    await new Promise((r) => setTimeout(r, 2600));

    // A fresh utterance should now land normally at the current caret.
    const cursorBefore = textarea.selectionStart;
    userInterim(provider, 'Second utterance.');
    userFinal(provider, 'Second utterance.');
    assert.ok(
      textarea.value.includes('Second utterance.'),
      'utterance after suppression window expires should be inserted',
    );
    assert.ok(
      textarea.selectionStart > cursorBefore,
      'cursor should advance past the new utterance',
    );
  });
});
