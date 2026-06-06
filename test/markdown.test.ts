/**
 * @fileoverview Tests for the miniMarkdown renderer.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { miniMarkdown, renderUserText } from '../src/util/markdown.ts';

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

  it('keeps a single <ol> when every source item repeats "1."', () => {
    // Browsers auto-number <li>, so the source numbers do not matter as
    // long as the items stay in ONE <ol>. The bug was multiple single-item
    // <ol>s (each restarting at 1).
    const result = miniMarkdown('1. first\n1. second\n1. third');
    assert.equal((result.match(/<ol>/g) || []).length, 1, `expected one <ol>, got: ${result}`);
    assert.ok(result.includes('<li>first</li><li>second</li><li>third</li>'));
  });

  it('keeps ordered list together across blank-line separators', () => {
    const result = miniMarkdown('1. first\n\n1. second\n\n1. third');
    assert.equal((result.match(/<ol>/g) || []).length, 1, `expected one <ol>, got: ${result}`);
    assert.ok(result.includes('<li>first</li><li>second</li><li>third</li>'));
  });

  it('keeps ordered list together with indented continuation lines', () => {
    // The "v13 spine" outline shape: each item has a title plus an indented
    // description line. Previously each item became its own single-item <ol>.
    const src = [
      '1. Title',
      '   Reimagine Robotics / Interactive robotics for the physical economy.',
      '1. Where are the robots?',
      '   Foundation models are making demos impressive.',
      '1. ARM origin story',
      '   We got impressive pilots.',
    ].join('\n');
    const result = miniMarkdown(src);
    assert.equal((result.match(/<ol>/g) || []).length, 1, `expected one <ol>, got: ${result}`);
    assert.equal((result.match(/<li>/g) || []).length, 3, `expected 3 <li>, got: ${result}`);
    assert.ok(result.includes('<li>Title<br>Reimagine Robotics / Interactive robotics for the physical economy.</li>'));
    assert.ok(result.includes('<li>Where are the robots?<br>Foundation models are making demos impressive.</li>'));
  });

  it('keeps bullet list together with indented continuation lines', () => {
    const result = miniMarkdown('- bullet one\n  more text\n- bullet two');
    assert.equal((result.match(/<ul>/g) || []).length, 1, `expected one <ul>, got: ${result}`);
    assert.ok(result.includes('<li>bullet one<br>more text</li>'));
    assert.ok(result.includes('<li>bullet two</li>'));
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

  it('groups consecutive `> ` lines into one <blockquote>', () => {
    const result = miniMarkdown('> line one\n> line two');
    assert.equal((result.match(/<blockquote>/g) || []).length, 1, `expected one blockquote, got: ${result}`);
    assert.ok(result.includes('<blockquote>line one<br>line two</blockquote>'));
  });

  it('does not wrap a blockquote in <p>', () => {
    assert.ok(!/\<p\>\s*\<blockquote\>/.test(miniMarkdown('> quoted')));
  });
});

describe('renderUserText', () => {
  it('escapes HTML', () => {
    assert.ok(renderUserText('<b>hi</b>').includes('&lt;b&gt;'));
  });

  it('converts newlines between plain lines to <br>', () => {
    assert.equal(renderUserText('line one\nline two'), 'line one<br>line two');
  });

  it('renders a `> ` quote as a blockquote', () => {
    const result = renderUserText('> quoted passage\n\nmy reply');
    assert.ok(result.includes('<blockquote>quoted passage</blockquote>'));
    assert.ok(result.includes('my reply'));
  });

  it('does not emit <br> bordering a blockquote', () => {
    // The blank line between quote and reply is absorbed by the block; only
    // a <br> between the two reply lines should remain.
    const result = renderUserText('> q\n\nreply line one\nreply line two');
    assert.ok(result.includes('<blockquote>q</blockquote>reply line one<br>reply line two'),
      `unexpected: ${result}`);
  });

  it('keeps multiple accumulated quotes as separate blockquotes', () => {
    const result = renderUserText('> first\n\nreply a\n\n> second\n\nreply b');
    assert.equal((result.match(/<blockquote>/g) || []).length, 2, `expected two blockquotes, got: ${result}`);
  });
});
