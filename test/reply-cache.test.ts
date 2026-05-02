/**
 * @fileoverview Tests for the LRU reply cache. Synthesises Blob-shaped
 * stubs (the cache only cares about .size); exercises hit/miss,
 * promote-on-access, eviction by count, and eviction by byte ceiling.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as cache from '../src/audio/turn-based/replyCache.ts';

function blobOfSize(bytes: number): Blob {
  // Minimal Blob shim — the cache only reads .size.
  return { size: bytes, type: 'audio/mpeg' } as unknown as Blob;
}

describe('replyCache LRU', () => {
  beforeEach(() => cache.clear());

  it('miss returns null', () => {
    assert.equal(cache.get('hi', 'voice-a'), null);
  });

  it('set then get returns the same blob', () => {
    const b = blobOfSize(1000);
    cache.set('hi', 'voice-a', b);
    assert.equal(cache.get('hi', 'voice-a'), b);
  });

  it('different voices are separate keys', () => {
    const a = blobOfSize(100);
    const b = blobOfSize(100);
    cache.set('hi', 'voice-a', a);
    cache.set('hi', 'voice-b', b);
    assert.equal(cache.get('hi', 'voice-a'), a);
    assert.equal(cache.get('hi', 'voice-b'), b);
  });

  it('cap-of-10 evicts oldest', () => {
    for (let i = 0; i < 11; i++) {
      cache.set(`reply ${i}`, 'v', blobOfSize(100));
    }
    assert.equal(cache.get('reply 0', 'v'), null, 'oldest should be evicted');
    assert.notEqual(cache.get('reply 10', 'v'), null, 'newest should still be present');
    assert.equal(cache.stats().size, 10);
  });

  it('get promotes to most-recent', () => {
    for (let i = 0; i < 10; i++) {
      cache.set(`reply ${i}`, 'v', blobOfSize(100));
    }
    // Touch reply 0 — it moves to most-recent.
    cache.get('reply 0', 'v');
    // Insert reply 10 — should evict reply 1 (now oldest), not reply 0.
    cache.set('reply 10', 'v', blobOfSize(100));
    assert.notEqual(cache.get('reply 0', 'v'), null, 'reply 0 was promoted, should survive');
    assert.equal(cache.get('reply 1', 'v'), null, 'reply 1 was oldest, should be evicted');
  });

  it('byte ceiling evicts even under entry cap', () => {
    // Each entry is 1MB; ceiling is 5MB. 6 entries → first should evict.
    for (let i = 0; i < 6; i++) {
      cache.set(`big ${i}`, 'v', blobOfSize(1024 * 1024));
    }
    const s = cache.stats();
    assert.ok(s.bytes <= 5 * 1024 * 1024, `bytes=${s.bytes} should be <=5MB`);
    assert.equal(cache.get('big 0', 'v'), null, 'biggest oldest should be evicted');
  });

  it('clear empties the cache', () => {
    cache.set('a', 'v', blobOfSize(100));
    cache.set('b', 'v', blobOfSize(100));
    cache.clear();
    assert.equal(cache.stats().size, 0);
    assert.equal(cache.stats().bytes, 0);
    assert.equal(cache.get('a', 'v'), null);
  });
});
