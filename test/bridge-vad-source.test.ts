/**
 * Unit tests for BridgeVadSource — the bridge-side VAD strategy.
 *
 * The source consumes {type:'speech-active', active:bool} envelopes
 * from the audio bridge over the data channel. Tests inject a stub
 * subscriber so they can drive synthetic envelopes without touching
 * RTCPeerConnection.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { BridgeVadSource } from '../src/audio/shared/vadSource.ts';

const stubMicStream: any = { getAudioTracks: () => [] };

/** Build a stub subscriber + a way to push envelopes into it. */
function makeSubscriber() {
  const listeners = new Set<(ev: any) => void>();
  const subscribe = (cb: (ev: any) => void) => {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  };
  const push = (ev: any) => { for (const cb of listeners) cb(ev); };
  return { subscribe, push, listenerCount: () => listeners.size };
}

describe('BridgeVadSource', () => {
  it('starts inactive', async () => {
    const { subscribe } = makeSubscriber();
    const src = new BridgeVadSource(subscribe);
    await src.start(stubMicStream, {});
    assert.equal(src.isSpeechActive(), false);
    assert.equal(src.getRecentPeak(), 0);
  });

  it('latches active=true on speech-active envelope', async () => {
    const { subscribe, push } = makeSubscriber();
    const src = new BridgeVadSource(subscribe);
    await src.start(stubMicStream, {});

    push({ type: 'speech-active', active: true });
    assert.equal(src.isSpeechActive(), true);

    push({ type: 'speech-active', active: false });
    assert.equal(src.isSpeechActive(), false);
  });

  it('ignores non-speech-active envelopes', async () => {
    const { subscribe, push } = makeSubscriber();
    const src = new BridgeVadSource(subscribe);
    await src.start(stubMicStream, {});

    push({ type: 'transcript', text: 'hello', is_final: false, role: 'user' });
    push({ type: 'listening' });
    push({ type: 'barge' });
    assert.equal(src.isSpeechActive(), false);

    push({ type: 'speech-active', active: true });
    assert.equal(src.isSpeechActive(), true);
  });

  it('coerces active to boolean', async () => {
    const { subscribe, push } = makeSubscriber();
    const src = new BridgeVadSource(subscribe);
    await src.start(stubMicStream, {});

    // Truthy non-bool → active
    push({ type: 'speech-active', active: 1 });
    assert.equal(src.isSpeechActive(), true);

    // Falsy non-bool → inactive
    push({ type: 'speech-active', active: 0 });
    assert.equal(src.isSpeechActive(), false);
  });

  it('stop() unsubscribes and resets state', async () => {
    const sub = makeSubscriber();
    const src = new BridgeVadSource(sub.subscribe);
    await src.start(stubMicStream, {});
    sub.push({ type: 'speech-active', active: true });
    assert.equal(src.isSpeechActive(), true);
    assert.equal(sub.listenerCount(), 1);

    await src.stop();
    assert.equal(src.isSpeechActive(), false);
    assert.equal(sub.listenerCount(), 0);

    // Post-stop envelopes are dropped (subscription gone).
    sub.push({ type: 'speech-active', active: true });
    assert.equal(src.isSpeechActive(), false);
  });

  it('start() is idempotent — does not double-subscribe', async () => {
    const sub = makeSubscriber();
    const src = new BridgeVadSource(sub.subscribe);
    await src.start(stubMicStream, {});
    await src.start(stubMicStream, {});
    assert.equal(sub.listenerCount(), 1);
  });

  it('survives a malformed envelope without crashing the latch', async () => {
    const { subscribe, push } = makeSubscriber();
    const src = new BridgeVadSource(subscribe);
    await src.start(stubMicStream, {});

    push(null);
    push(undefined);
    push({});
    push({ type: 'speech-active' }); // missing active field
    assert.equal(src.isSpeechActive(), false);

    push({ type: 'speech-active', active: true });
    assert.equal(src.isSpeechActive(), true);
  });
});
