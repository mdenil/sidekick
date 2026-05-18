/**
 * @fileoverview Tests for the miniMarkdown renderer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { miniMarkdown } from '../src/util/markdown.ts';

describe('miniMarkdown', () => {
  it('escapes HTML entities', () => {
    assert.ok(miniMarkdown('<script>alert("xss")</script>').includes('&lt;script&gt;'));
  });

  it('renders bold', () => {
    assert.ok(miniMarkdown('hello **world**').includes('<strong>world</strong>'));
  });

  it('renders italic', () => {
    assert.ok(miniMarkdown('hello *world*').includes('<em>world</em>'));
  });

  it('renders inline code', () => {
    assert.ok(miniMarkdown('use `npm install`').includes('<code>npm install</code>'));
  });

  it('renders code blocks', () => {
    const result = miniMarkdown('```\nconst x = 1;\n```');
    assert.ok(result.includes('<pre><code>'));
    assert.ok(result.includes('const x = 1;'));
  });

  it('renders headings', () => {
    assert.ok(miniMarkdown('# Title').includes('<h1>Title</h1>'));
    assert.ok(miniMarkdown('## Subtitle').includes('<h2>Subtitle</h2>'));
    assert.ok(miniMarkdown('### Section').includes('<h3>Section</h3>'));
  });

  it('renders bullet lists', () => {
    const result = miniMarkdown('- item one\n- item two');
    assert.ok(result.includes('<ul>'));
    assert.ok(result.includes('<li>item one</li>'));
    assert.ok(result.includes('<li>item two</li>'));
  });

  it('renders markdown links', () => {
    const result = miniMarkdown('[click here](https://example.com)');
    assert.ok(result.includes('<a href="https://example.com">click here</a>'));
  });

  it('renders bare URLs', () => {
    const result = miniMarkdown('visit https://example.com today');
    assert.ok(result.includes('<a href="https://example.com">'));
  });

  it('renders angle-bracketed URLs', () => {
    const result = miniMarkdown('link: <https://example.com/page>');
    assert.ok(result.includes('<a href="https://example.com/page">'));
    assert.ok(!result.includes('&lt;'));
  });

  it('wraps paragraphs', () => {
    const result = miniMarkdown('first paragraph\n\nsecond paragraph');
    assert.ok(result.includes('<p>'));
  });

  it('handles empty string', () => {
    // Empty input produces a single empty paragraph wrapper
    assert.equal(miniMarkdown(''), '<p></p>');
  });

  it('does not double-escape already-safe text', () => {
    const result = miniMarkdown('Tom & Jerry');
    assert.ok(result.includes('Tom &amp; Jerry'));
    assert.ok(!result.includes('&amp;amp;'));
  });

  it('renders pipe-style tables', () => {
    const src = [
      '| Name | Score |',
      '| :--- | ---: |',
      '| Alice | 90 |',
      '| Bob | 85 |',
    ].join('\n');
    const html = miniMarkdown(src);
    assert.ok(html.includes('<table>'), 'has table');
    assert.ok(html.includes('<th style="text-align:left">Name</th>'), 'left-aligned header');
    assert.ok(html.includes('<th style="text-align:right">Score</th>'), 'right-aligned header');
    assert.ok(html.includes('<td style="text-align:left">Alice</td>'), 'left-aligned cell');
    assert.ok(html.includes('<td style="text-align:right">90</td>'), 'right-aligned cell');
  });

  it('ignores pipe-lines without a separator row', () => {
    // One pipe line alone shouldn't be mistaken for a table.
    const html = miniMarkdown('| not a table |');
    assert.ok(!html.includes('<table>'));
  });

  it('renders numbered lists', () => {
    const result = miniMarkdown('1. first\n2. second\n3. third');
    assert.ok(result.includes('<ol>'));
    assert.ok(result.includes('<li>first</li>'));
    assert.ok(result.includes('<li>second</li>'));
    assert.ok(result.includes('<li>third</li>'));
  });

  it('renders <br> between adjacent **bold** lines in one paragraph', () => {
    // Field bug 2026-05-17: when a chunk starts with <strong> (or any
    // inline element), the old paragraph step skipped the \n→<br> rewrite
    // and the two lines collapsed onto one. New behavior: only true
    // block-level openers skip the wrap, so this paragraph gets <p>…<br>…</p>.
    const result = miniMarkdown('**foo:** 0\n**bar:** 0');
    assert.ok(result.includes('<br>'), `expected <br> between bold lines, got: ${result}`);
    assert.ok(result.includes('<strong>foo:</strong>'));
    assert.ok(result.includes('<strong>bar:</strong>'));
  });

  it('does not wrap block-level rendered output in <p>', () => {
    // <pre>, <ul>, <ol>, <h2>, etc. are produced by earlier rules and
    // must not be wrapped in <p> (invalid HTML).
    assert.ok(!/\<p\>\s*\<pre\>/.test(miniMarkdown('```\ncode\n```')));
    assert.ok(!/\<p\>\s*\<ul\>/.test(miniMarkdown('- a\n- b')));
    assert.ok(!/\<p\>\s*\<ol\>/.test(miniMarkdown('1. a\n2. b')));
    assert.ok(!/\<p\>\s*\<h2\>/.test(miniMarkdown('## heading')));
  });
});
