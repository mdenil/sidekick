/**
 * @fileoverview Regression test for the composer caret-position cache.
 *
 * The cache backs `getLastCaret()` and is used by main.ts's
 * `captureComposerCursor()` at mic-button pointerdown to recover the
 * user's intended caret position when the textarea has just been
 * blurred (button mousedown shifts focus before our handler runs;
 * `selectionStart` can read stale post-blur on some browsers).
 *
 * Field bug 2026-05-07 (Jonathan): user moves cursor with arrows in a
 * non-empty composer, voice still lands at value.length instead of the
 * caret. Path traced through ensureAnchor's `selectionStart ?? value.length`
 * fallback. Cache fix means captureComposerCursor returns the cached
 * caret regardless of focus state at gesture time.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

(globalThis as any).window = (globalThis as any).window || {};
(globalThis as any).location = (globalThis as any).location || { search: '' };

const docListeners: Record<string, Array<(ev: any) => void>> = {};
let activeElementRef: any = null;
(globalThis as any).document = {
  addEventListener: (type: string, fn: (ev: any) => void) => {
    (docListeners[type] ||= []).push(fn);
  },
  removeEventListener: () => {},
  get activeElement() { return activeElementRef; },
};

class FakeTextarea {
  value = '';
  selectionStart = 0;
  selectionEnd = 0;
  addEventListener() {}
  removeEventListener() {}
  setRangeText() {}
  setSelectionRange(s: number, e: number) {
    this.selectionStart = s; this.selectionEnd = e;
  }
  dispatchEvent() {}
}

import * as composer from '../src/composer.ts';

function fireSelectionChange() {
  const list = docListeners['selectionchange'];
  if (!list) return;
  for (const fn of list) fn({});
}

describe('composer caret-position cache', () => {
  let textarea: FakeTextarea;

  beforeEach(() => {
    textarea = new FakeTextarea();
    activeElementRef = null;
    docListeners['selectionchange'] = [];
    composer.init({ input: textarea as unknown as HTMLTextAreaElement });
  });

  it('returns null until the user has moved the caret', () => {
    assert.equal(composer.getLastCaret(), null);
  });

  it('updates when selectionchange fires AND textarea is focused', () => {
    textarea.value = 'hello world';
    activeElementRef = textarea;
    textarea.selectionStart = 5;
    fireSelectionChange();
    assert.equal(composer.getLastCaret(), 5);
  });

  it('does NOT update when textarea is blurred (different activeElement)', () => {
    textarea.value = 'hello world';
    activeElementRef = textarea;
    textarea.selectionStart = 5;
    fireSelectionChange();
    assert.equal(composer.getLastCaret(), 5);

    // User clicks something else — focus moves away.
    activeElementRef = { tagName: 'BUTTON' };
    textarea.selectionStart = 0;  // simulate a browser that resets on blur
    fireSelectionChange();
    // Cache still reflects the user's last engaged caret, not the
    // post-blur stale read.
    assert.equal(composer.getLastCaret(), 5);
  });

  it('survives focus shift (mic-button gesture scenario)', () => {
    textarea.value = 'pre-existing draft text';
    activeElementRef = textarea;
    // User arrow-keys / clicks to mid-text.
    textarea.selectionStart = 12;
    fireSelectionChange();

    // User clicks mic button — focus moves to button BEFORE our
    // pointerdown handler reads selectionStart. Some browsers also
    // wipe selectionStart on blur.
    activeElementRef = { tagName: 'BUTTON' };
    textarea.selectionStart = textarea.value.length;  // browser quirk

    // captureComposerCursor (in main.ts) would now read getLastCaret
    // because activeElement !== textarea. It gets the user's intent.
    assert.equal(composer.getLastCaret(), 12);
  });

  it('tracks the most recent move, not just the first', () => {
    textarea.value = 'one two three four';
    activeElementRef = textarea;

    textarea.selectionStart = 4;  fireSelectionChange();
    textarea.selectionStart = 8;  fireSelectionChange();
    textarea.selectionStart = 14; fireSelectionChange();

    assert.equal(composer.getLastCaret(), 14);
  });
});
