/**
 * @fileoverview Tests for the pure pieces of chunked transcription:
 * threshold logic, PCM slicing with overlap, WAV encoding, and seam
 * stitching with overlap dedup. decodeToMono16k is browser-only
 * (OfflineAudioContext) and is covered by the smoke instead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  needsChunking, slicePcm, encodeWav, stitchTranscripts,
  CHUNK_THRESHOLD_MS, CHUNK_SEC, OVERLAP_SEC, TARGET_RATE,
} from './chunkedTranscribe.ts';

describe('needsChunking', () => {
  it('uses duration when known', () => {
    assert.equal(needsChunking(CHUNK_THRESHOLD_MS - 1, 99_000_000), false);
    assert.equal(needsChunking(CHUNK_THRESHOLD_MS + 1, 10), true);
  });

  it('falls back to blob size when duration is missing', () => {
    assert.equal(needsChunking(undefined, 1_000_000), false);
    assert.equal(needsChunking(undefined, 5_000_000), true);
    assert.equal(needsChunking(0, 5_000_000), true);
  });
});

describe('slicePcm', () => {
  it('returns a single chunk for short audio', () => {
    const pcm = new Float32Array(10 * TARGET_RATE);
    const chunks = slicePcm(pcm);
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].length, pcm.length);
  });

  it('overlaps adjacent chunks by OVERLAP_SEC', () => {
    const totalSec = 200;
    const pcm = new Float32Array(totalSec * TARGET_RATE);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i % 100 / 100;
    const chunks = slicePcm(pcm);
    assert.ok(chunks.length >= 2, 'should split');
    const overlapLen = Math.floor(OVERLAP_SEC * TARGET_RATE);
    const chunkLen = Math.floor(CHUNK_SEC * TARGET_RATE);
    assert.equal(chunks[0].length, chunkLen);
    // tail of chunk 0 == head of chunk 1
    const tail = chunks[0].subarray(chunkLen - overlapLen);
    const head = chunks[1].subarray(0, overlapLen);
    assert.deepEqual(Array.from(tail.slice(0, 5)), Array.from(head.slice(0, 5)));
  });

  it('covers every sample exactly once accounting for overlap', () => {
    const pcm = new Float32Array(173 * TARGET_RATE);
    const chunks = slicePcm(pcm);
    const stride = Math.floor((CHUNK_SEC - OVERLAP_SEC) * TARGET_RATE);
    let covered = 0;
    for (let i = 0; i < chunks.length; i++) {
      covered = i * stride + chunks[i].length;
    }
    assert.equal(covered, pcm.length, 'last chunk must reach the end');
    for (const c of chunks) assert.ok(c.length > 0, 'no empty chunks');
  });
});

describe('encodeWav', () => {
  it('writes a valid 16-bit mono PCM header', async () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWav(pcm, TARGET_RATE);
    assert.equal(blob.type, 'audio/wav');
    assert.equal(blob.size, 44 + pcm.length * 2);
    const v = new DataView(await blob.arrayBuffer());
    const str = (off: number, n: number) =>
      String.fromCharCode(...new Uint8Array(v.buffer, off, n));
    assert.equal(str(0, 4), 'RIFF');
    assert.equal(str(8, 4), 'WAVE');
    assert.equal(v.getUint16(22, true), 1, 'mono');
    assert.equal(v.getUint32(24, true), TARGET_RATE);
    assert.equal(v.getUint16(34, true), 16, 'bit depth');
    assert.equal(v.getInt16(44, true), 0);
    assert.equal(v.getInt16(46, true), Math.trunc(0.5 * 0x7fff));
    assert.equal(v.getInt16(50, true), 0x7fff, 'clamps +1');
    assert.equal(v.getInt16(52, true), -0x8000, 'clamps -1');
  });
});

describe('stitchTranscripts', () => {
  it('joins exact-overlap seams without duplication', () => {
    const out = stitchTranscripts([
      'one two three four five six',
      'four five six seven eight nine',
    ]);
    assert.equal(out, 'one two three four five six seven eight nine');
  });

  it('tolerates minor transcription disagreement in the overlap', () => {
    // "their" vs "there" — one mismatch in a 4-word seam = 75% match.
    const out = stitchTranscripts([
      'we should meet over their by the dock',
      'over there by the dock at noon',
    ]);
    assert.equal(out, 'we should meet over their by the dock at noon');
  });

  it('ignores punctuation and case at the seam', () => {
    const out = stitchTranscripts([
      'Let me know. About the plan,',
      'about the plan tomorrow morning',
    ]);
    assert.equal(out, 'Let me know. About the plan, tomorrow morning');
  });

  it('plain-joins when there is no overlap match', () => {
    const out = stitchTranscripts(['alpha bravo charlie', 'delta echo foxtrot']);
    assert.equal(out, 'alpha bravo charlie delta echo foxtrot');
  });

  it('drops empty chunks (silent segments)', () => {
    assert.equal(stitchTranscripts(['hello world', '', '  ', 'goodbye']), 'hello world goodbye');
    assert.equal(stitchTranscripts(['', '']), '');
    assert.equal(stitchTranscripts([]), '');
  });

  it('dedups digit runs the two STT passes formatted differently (device regression)', () => {
    // Cold-start splice on device: head from batch /transcribe, tail from
    // the streaming bridge — counted digits got collapsed into single
    // number tokens with different boundaries, hiding the overlap.
    const out = stitchTranscripts([
      '1234567.',
      '34567, No need to reply.',
    ]);
    assert.equal(out, '1234567. No need to reply.');
  });

  it('matches digit overlap across different groupings', () => {
    const out = stitchTranscripts([
      'meet at 10 30 am',
      '1030 am sounds good',
    ]);
    assert.equal(out, 'meet at 10 30 am sounds good');
  });

  it('never cuts in the middle of a number token', () => {
    // "34" overlaps the head of "3456" but dropping it would also drop
    // the non-overlapping "56" — must plain-join instead.
    const out = stitchTranscripts(['one two 34', '3456 seven']);
    assert.equal(out, 'one two 34 3456 seven');
  });

  it('never matches seams shorter than 3 words (false-positive guard)', () => {
    // A 2-word coincidence ("three four") must NOT trigger dedup — plain
    // join is the safe failure mode.
    const out = stitchTranscripts(['one two three four', 'three four']);
    assert.equal(out, 'one two three four three four');
  });
});
