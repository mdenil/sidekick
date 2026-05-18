/**
 * @fileoverview Tests for the schema-version gate in sessionCache.
 *
 * Crack B of the 2026-05-17 turn-taking audit: every cached record
 * (list + per-chat messages) carries a `schemaVersion` so a build that
 * bumps the wire-shape constant discards entries written by older
 * builds on the next read. This test is the cheap unit gate for the
 * pure-logic half (the predicate). The IDB plumbing is exercised by
 * smoke runs against a real browser.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CACHE_SCHEMA_VERSION,
  isCurrentCacheRecord,
} from '../src/sessionCache.ts';

describe('sessionCache schema gate', () => {
  it('rejects null / undefined / non-object', () => {
    assert.equal(isCurrentCacheRecord(null), false);
    assert.equal(isCurrentCacheRecord(undefined), false);
    assert.equal(isCurrentCacheRecord('string'), false);
    assert.equal(isCurrentCacheRecord(42), false);
  });

  it('rejects records missing schemaVersion', () => {
    assert.equal(isCurrentCacheRecord({ sessions: [], updatedAt: Date.now() }), false);
  });

  it('rejects records with an older schemaVersion', () => {
    assert.equal(isCurrentCacheRecord({ schemaVersion: CACHE_SCHEMA_VERSION - 1 }), false);
    assert.equal(isCurrentCacheRecord({ schemaVersion: 0 }), false);
  });

  it('rejects records with a future schemaVersion', () => {
    // A downgrade (build N+1 wrote it, build N reads it) is also stale.
    assert.equal(isCurrentCacheRecord({ schemaVersion: CACHE_SCHEMA_VERSION + 1 }), false);
  });

  it('accepts records with the current schemaVersion', () => {
    assert.equal(
      isCurrentCacheRecord({ schemaVersion: CACHE_SCHEMA_VERSION, sessions: [] }),
      true,
    );
    assert.equal(
      isCurrentCacheRecord({ schemaVersion: CACHE_SCHEMA_VERSION, messages: [], updatedAt: 1 }),
      true,
    );
  });

  it('CACHE_SCHEMA_VERSION is a positive integer', () => {
    assert.ok(Number.isInteger(CACHE_SCHEMA_VERSION), 'must be integer');
    assert.ok(CACHE_SCHEMA_VERSION >= 1, 'must be >= 1');
  });
});
