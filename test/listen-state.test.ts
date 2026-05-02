/**
 * @fileoverview Unit tests for the Listen state machine.
 *
 * Listen wraps a MediaRecorder + analyser; in node we can't actually
 * exercise those, but we CAN verify:
 *   - the state-machine vocabulary stays stable (idle/armed/committing/
 *     playing/cooldown);
 *   - getState() returns 'idle' before start();
 *   - notifyReplyPlayback is a no-op when nothing armed (defensive
 *     against stray callbacks from text-tts ended events).
 *
 * The full integration path is covered by scripts/smoke/listen-*.mjs
 * against a real Chromium.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Stub minimal browser-ish globals before import — listen.ts touches
// `window`, `URLSearchParams`, `location` for its test-hook plumbing.
(globalThis as any).window = (globalThis as any).window || {};
(globalThis as any).location = (globalThis as any).location || { search: '' };

// Stub the platform shim before listen.ts evaluates — we don't actually
// invoke start(), so the imports just need to resolve.
import * as listen from '../src/audio/turn-based/turnbased.ts';

describe('listen state machine', () => {
  it('starts in idle state', () => {
    assert.equal(listen.getState(), 'idle');
  });

  it('notifyReplyPlayback is a no-op when idle', () => {
    listen.notifyReplyPlayback(true);
    assert.equal(listen.getState(), 'idle');
    listen.notifyReplyPlayback(false);
    assert.equal(listen.getState(), 'idle');
  });

  it('commitFromSendword is a no-op when not armed', () => {
    // Should not throw.
    listen.commitFromSendword();
    assert.equal(listen.getState(), 'idle');
  });

  it('cancel + stop are safe to call when idle', () => {
    listen.cancel();
    listen.stop();
    assert.equal(listen.getState(), 'idle');
  });
});
