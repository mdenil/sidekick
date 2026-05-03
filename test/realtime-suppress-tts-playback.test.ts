/**
 * @fileoverview Lifecycle tests for src/audio/realtime/suppress.ts —
 * specifically the `ttsPlaying` flag that gates the realtime BargeWindow.
 *
 * Regression cover for v0.381 → v0.382: the BargeWindow was originally
 * gated on `isSuppressing()` (a SHORT, AEC-tail-focused transcript-
 * suppression window — final + 1.2s grace). TTS audio plays through
 * the speaker for many seconds AFTER `final`, so the gate flipped off
 * mid-playback and barge could only fire in the first ~1.2s of any
 * reply. Caught in field testing 2026-05-03 (Mac, quiet room) where
 * shouting at the speaker during a 10-count produced zero fires.
 *
 * The fix: separate `ttsPlaying` flag, set on `onAssistantDelta`,
 * cleared on `onListening` (the bridge's authoritative "TTS audio
 * done" envelope) or `onBarge`. These tests pin that lifecycle so
 * future refactors can't quietly recouple barge-gating to the wrong
 * signal again.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import * as suppress from '../src/audio/realtime/suppress.ts';

describe('realtime suppress: ttsPlaying lifecycle', () => {
  beforeEach(() => suppress.reset());

  it('starts false on a fresh call', () => {
    assert.equal(suppress.isTtsPlaying(), false);
  });

  it('flips true on first assistant delta', () => {
    suppress.onAssistantDelta();
    assert.equal(suppress.isTtsPlaying(), true);
  });

  it('stays true across multiple deltas in the same reply', () => {
    suppress.onAssistantDelta();
    suppress.onAssistantDelta();
    suppress.onAssistantDelta();
    assert.equal(suppress.isTtsPlaying(), true);
  });

  it('STAYS TRUE after onAssistantFinal — TTS audio plays past the text-final boundary', async () => {
    // This is the core regression: the OLD gating on isSuppressing()
    // would have flipped false 1.2s after final. ttsPlaying must
    // outlive that grace window because the speaker is still emitting.
    suppress.onAssistantDelta();
    suppress.onAssistantFinal();
    // Wait past the SUPPRESS_GRACE_MS (1200ms) — isSuppressing() will
    // return false here, but isTtsPlaying() must still return true.
    await new Promise(r => setTimeout(r, 1300));
    assert.equal(
      suppress.isTtsPlaying(), true,
      'ttsPlaying flipped false after suppress grace — barge will be ungated mid-TTS',
    );
    assert.equal(
      suppress.isSuppressing(), false,
      'isSuppressing() should have cleared after grace (sanity check on the OTHER signal)',
    );
  });

  it('flips false on bridge listening envelope', () => {
    suppress.onAssistantDelta();
    suppress.onListening();
    assert.equal(suppress.isTtsPlaying(), false);
  });

  it('stays true briefly after barge (drain grace), then flips false', async () => {
    // v0.388: barge defers ttsPlaying clear by TTS_DRAIN_GRACE_MS (600ms)
    // so the speaker-buffer tail still draining after the bridge halts
    // TTS doesn't get STT-transcribed as a fake user turn (the
    // "1 2 3 ... zero" feedback loop). suppressing flips immediately
    // (so the user's intentional follow-up speech becomes the next
    // turn) but ttsPlaying is held until the tail drains.
    suppress.onAssistantDelta();
    suppress.onBarge();
    assert.equal(suppress.isTtsPlaying(), true,
      'ttsPlaying should still be true immediately after barge — speaker tail draining');
    assert.equal(suppress.isSuppressing(), false,
      'isSuppressing should clear immediately on barge — sanity check');
    await new Promise(r => setTimeout(r, 700));
    assert.equal(suppress.isTtsPlaying(), false,
      'ttsPlaying should clear after TTS_DRAIN_GRACE_MS (~600ms)');
  });

  it('clears on reset (call lifecycle)', () => {
    suppress.onAssistantDelta();
    suppress.reset();
    assert.equal(suppress.isTtsPlaying(), false);
  });

  it('next reply re-arms ttsPlaying after a listening envelope', () => {
    // Two-turn sequence: reply, listening, next reply.
    suppress.onAssistantDelta();
    suppress.onListening();
    assert.equal(suppress.isTtsPlaying(), false);
    suppress.onAssistantDelta();
    assert.equal(suppress.isTtsPlaying(), true);
  });
});
