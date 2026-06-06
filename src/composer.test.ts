/**
 * @fileoverview Tests for formatQuoteBlock — the pure quote-insertion
 * formatter behind select-to-quote. Verifies the `> ` prefixing,
 * caret-below placement, and blank-line separation that keeps multiple
 * accumulated quote+reply pairs as distinct blockquotes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatQuoteBlock } from './composer.ts';

describe('formatQuoteBlock', () => {
  it('prefixes a single line and parks the caret below the quote', () => {
    const { value, caret } = formatQuoteBlock('hello world', '');
    assert.equal(value, '> hello world\n\n');
    assert.equal(caret, value.length);
  });

  it('prefixes every line of a multi-line selection', () => {
    const { value } = formatQuoteBlock('line one\nline two', '');
    assert.equal(value, '> line one\n> line two\n\n');
  });

  it('normalizes CRLF / CR before prefixing', () => {
    const { value } = formatQuoteBlock('a\r\nb\rc', '');
    assert.equal(value, '> a\n> b\n> c\n\n');
  });

  it('separates a new quote from existing reply text with a blank line', () => {
    const existing = '> earlier quote\n\nmy reply';
    const { value } = formatQuoteBlock('second quote', existing);
    assert.equal(value, '> earlier quote\n\nmy reply\n\n> second quote\n\n');
  });

  it('does not add extra blank lines when existing already ends in one', () => {
    const existing = '> q\n\n';
    const { value } = formatQuoteBlock('next', existing);
    assert.equal(value, '> q\n\n> next\n\n');
  });

  it('adds a single newline when existing ends in exactly one newline', () => {
    const existing = 'reply\n';
    const { value } = formatQuoteBlock('q', existing);
    assert.equal(value, 'reply\n\n> q\n\n');
  });
});
