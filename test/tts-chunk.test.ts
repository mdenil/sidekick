/**
 * @fileoverview Tests for `chunkForTts` — the sentence-boundary splitter
 * that powers streamed (multi-chunk) TTS playback in
 * src/audio/turn-based/tts.ts.
 *
 * The streamed path fires one /tts POST per chunk with capped concurrency
 * and plays chunk 0 the instant it lands, so first-audio latency drops
 * from ~30s (whole-reply synth) to ~1-3s (one-chunk synth). These tests
 * pin the chunking contract the rest of that path depends on:
 *   - sentence boundaries, never mid-word
 *   - a short reply stays ONE chunk (so it plays exactly like before)
 *   - an over-long single sentence hard-splits under the per-request cap
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { chunkForTts } from '../src/audio/turn-based/tts.ts';

// Keep in sync with the consts in tts.ts.
const CHUNK_MAX = 360;

describe('chunkForTts', () => {
  it('returns no chunks for empty / whitespace', () => {
    assert.deepEqual(chunkForTts(''), []);
    assert.deepEqual(chunkForTts('   '), []);
  });

  it('keeps a short single-sentence reply as ONE chunk', () => {
    const chunks = chunkForTts('Hello there, how are you today?');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], 'Hello there, how are you today?');
  });

  it('keeps a short multi-sentence reply as ONE chunk (under target)', () => {
    // Three short sentences well under CHUNK_TARGET (260) — should pack
    // into a single chunk so a brief reply behaves like the old path.
    const text = 'Sure. Done. Anything else?';
    const chunks = chunkForTts(text);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0], text);
  });

  it('splits a multi-paragraph reply into multiple ordered chunks', () => {
    const sentence = 'This is a reasonably long sentence that carries some real content to synthesize. ';
    const text = sentence.repeat(8).trim(); // ~700 chars → several chunks
    const chunks = chunkForTts(text);
    assert.ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
    // Order + completeness: concatenation (collapsing whitespace) equals
    // the original collapsed text — nothing dropped, nothing reordered.
    const rejoined = chunks.join(' ').replace(/\s+/g, ' ').trim();
    const original = text.replace(/\s+/g, ' ').trim();
    assert.equal(rejoined, original);
  });

  it('never splits mid-word on normal sentence boundaries', () => {
    const text =
      'Robotics is fascinating because it blends mechanics with software. '
      + 'Each joint needs precise control. '
      + 'Sensors feed back position and force. '
      + 'The controller closes the loop in real time. '
      + 'It is an elegant dance of physics and code.';
    const chunks = chunkForTts(text);
    for (const c of chunks) {
      // No chunk should begin or end on a partial word (a letter pressed
      // against a boundary with no surrounding space) for normal prose.
      assert.equal(c, c.trim());
      assert.ok(c.length > 0);
    }
    const rejoined = chunks.join(' ').replace(/\s+/g, ' ').trim();
    assert.equal(rejoined, text.replace(/\s+/g, ' ').trim());
  });

  it('hard-splits an over-long single sentence under the per-request cap', () => {
    // One sentence with no punctuation, far longer than CHUNK_MAX.
    const longRun = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
    assert.ok(longRun.length > CHUNK_MAX);
    const chunks = chunkForTts(longRun);
    assert.ok(chunks.length >= 2, 'over-long sentence should hard-split');
    for (const c of chunks) {
      assert.ok(c.length <= CHUNK_MAX, `chunk over cap: ${c.length} > ${CHUNK_MAX}`);
    }
    // Hard-split happens on spaces → no word is broken in half.
    const words = longRun.split(' ');
    const rejoinedWords = chunks.join(' ').split(/\s+/);
    assert.deepEqual(rejoinedWords, words);
  });
});
