/**
 * Unit tests for FallbackVadSource — bridge-preferred VAD with a
 * client-side Silero fallback when the bridge reports no server-side VAD.
 *
 * The capability handshake is driven by injected deps: a stub subscriber
 * (drives synthetic {type:'barge-vad'} replies) and a stub query sender.
 * Bridge/client are FakeVadSources so we can assert which one reads route
 * through after the decision, without touching RTCPeerConnection or Silero.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FallbackVadSource, FakeVadSource } from '../src/audio/shared/vadSource.ts';

const stubMicStream: any = { getAudioTracks: () => [] };

const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Stub envelope subscriber + a push() to drive synthetic replies. */
function makeSubscriber() {
  const listeners = new Set<(ev: any) => void>();
  const subscribe = (cb: (ev: any) => void) => {
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  };
  const push = (ev: any) => { for (const cb of listeners) cb(ev); };
  return { subscribe, push, listenerCount: () => listeners.size };
}

describe('FallbackVadSource', () => {
  it('stays on bridge when server reports available=true', async () => {
    const { subscribe, push } = makeSubscriber();
    const bridge = new FakeVadSource();
    const client = new FakeVadSource();
    const src = new FallbackVadSource({
      bridge, client, subscribe,
      query: () => true,
      deadlineMs: 1000, pollMs: 10,
    });
    await src.start(stubMicStream, {});
    assert.equal(bridge.isStarted(), true);

    push({ type: 'barge-vad', available: true });
    await tick();

    // Reads route through bridge; client never started.
    assert.equal(client.isStarted(), false);
    bridge.setSpeechActive(true);
    assert.equal(src.isSpeechActive(), true);
    bridge.setSpeechActive(false);
    assert.equal(src.isSpeechActive(), false);

    await src.stop();
  });

  it('falls back to client when server reports available=false', async () => {
    const { subscribe, push } = makeSubscriber();
    const bridge = new FakeVadSource();
    const client = new FakeVadSource();
    const src = new FallbackVadSource({
      bridge, client, subscribe,
      query: () => true,
      deadlineMs: 1000, pollMs: 10,
    });
    await src.start(stubMicStream, {});

    push({ type: 'barge-vad', available: false });
    await tick();

    // Client started, bridge released; reads route through client.
    assert.equal(client.isStarted(), true);
    assert.equal(bridge.isStarted(), false);
    client.setSpeechActive(true);
    assert.equal(src.isSpeechActive(), true);

    await src.stop();
  });

  it('falls back to client when no reply arrives by the deadline', async () => {
    const { subscribe } = makeSubscriber();
    const bridge = new FakeVadSource();
    const client = new FakeVadSource();
    const src = new FallbackVadSource({
      bridge, client, subscribe,
      query: () => false, // channel never opens — query never lands
      deadlineMs: 30, pollMs: 5,
    });
    await src.start(stubMicStream, {});

    await sleep(60);

    assert.equal(client.isStarted(), true, 'expected client fallback after deadline');
    assert.equal(bridge.isStarted(), false);

    await src.stop();
  });

  it('re-sends the query each poll until the channel opens', async () => {
    const { subscribe } = makeSubscriber();
    let calls = 0;
    const src = new FallbackVadSource({
      bridge: new FakeVadSource(),
      client: new FakeVadSource(),
      subscribe,
      query: () => { calls++; return false; },
      deadlineMs: 30, pollMs: 5,
    });
    await src.start(stubMicStream, {});
    await sleep(40);
    // One immediate send + several polls.
    assert.ok(calls > 1, `expected repeated queries, got ${calls}`);
    await src.stop();
  });

  it('ignores unrelated envelopes during the handshake', async () => {
    const { subscribe, push } = makeSubscriber();
    const bridge = new FakeVadSource();
    const client = new FakeVadSource();
    const src = new FallbackVadSource({
      bridge, client, subscribe,
      query: () => true,
      deadlineMs: 1000, pollMs: 10,
    });
    await src.start(stubMicStream, {});

    push({ type: 'speech-active', active: true });
    push({ type: 'transcript', text: 'hi', is_final: false, role: 'user' });
    await tick();
    // No decision yet — still on bridge, client not started.
    assert.equal(client.isStarted(), false);

    push({ type: 'barge-vad', available: true });
    await tick();
    assert.equal(client.isStarted(), false);

    await src.stop();
  });

  it('stop() clears the handshake and unsubscribes', async () => {
    const sub = makeSubscriber();
    const src = new FallbackVadSource({
      bridge: new FakeVadSource(),
      client: new FakeVadSource(),
      subscribe: sub.subscribe,
      query: () => false,
      deadlineMs: 1000, pollMs: 10,
    });
    await src.start(stubMicStream, {});
    assert.equal(sub.listenerCount(), 1);

    await src.stop();
    assert.equal(sub.listenerCount(), 0);
  });

  it('a late reply after the deadline does not override the fallback', async () => {
    const { subscribe, push } = makeSubscriber();
    const bridge = new FakeVadSource();
    const client = new FakeVadSource();
    const src = new FallbackVadSource({
      bridge, client, subscribe,
      query: () => false,
      deadlineMs: 20, pollMs: 5,
    });
    await src.start(stubMicStream, {});
    await sleep(40);
    assert.equal(client.isStarted(), true);

    // Stray late reply — decision already made, must be a no-op.
    push({ type: 'barge-vad', available: true });
    await tick();
    assert.equal(client.isStarted(), true);
    assert.equal(bridge.isStarted(), false);

    await src.stop();
  });
});
