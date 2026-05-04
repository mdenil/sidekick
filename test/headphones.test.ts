/**
 * Unit tests for the `audio/shared/headphones` module — the SSOT for
 * "is barge physically possible?" Tests cover the iOS audioSession
 * detection (mocked), the unknown-platform fallback, and the
 * isBargeAvailable() decision matrix that consumers (slider
 * visibility, settings hint, future tap-to-interrupt) all read from.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Module-level state in headphones.ts is set on first init(). Each
// test mutates the global navigator.audioSession stub and re-imports
// to exercise different routings. We use a fresh dynamic-import per
// test to bypass the module's `initialized` cache.
async function freshHeadphones() {
  const url = '../src/audio/shared/headphones.ts?cb=' + Math.random();
  return await import(url);
}

function setStubAudioSession(type: string | undefined): void {
  const g = globalThis as any;
  if (!g.window) g.window = g;
  if (!g.navigator) g.navigator = {};
  if (type === undefined) {
    delete (g.navigator as any).audioSession;
  } else {
    (g.navigator as any).audioSession = {
      type,
      addEventListener: () => {},
    };
  }
}

beforeEach(() => {
  setStubAudioSession(undefined);
});

afterEach(() => {
  setStubAudioSession(undefined);
});

describe('headphones — getRouting()', () => {
  it("returns 'unknown' when audioSession API is missing (Mac/desktop)", async () => {
    setStubAudioSession(undefined);
    const h = await freshHeadphones();
    assert.equal(h.getRouting(), 'unknown');
  });

  it("returns 'speaker' when iOS reports type='speaker'", async () => {
    setStubAudioSession('speaker');
    const h = await freshHeadphones();
    assert.equal(h.getRouting(), 'speaker');
  });

  it("returns 'speaker' when iOS reports type='play-and-record'", async () => {
    // iOS uses play-and-record category for built-in speakerphone path
    setStubAudioSession('play-and-record');
    const h = await freshHeadphones();
    assert.equal(h.getRouting(), 'speaker');
  });

  it("returns 'isolated' when iOS reports type='headphones'", async () => {
    setStubAudioSession('headphones');
    const h = await freshHeadphones();
    assert.equal(h.getRouting(), 'isolated');
  });

  it("returns 'isolated' when iOS reports type='bluetooth'", async () => {
    setStubAudioSession('bluetooth');
    const h = await freshHeadphones();
    assert.equal(h.getRouting(), 'isolated');
  });

  it("returns 'isolated' when iOS reports type='airplay'", async () => {
    setStubAudioSession('airplay');
    const h = await freshHeadphones();
    assert.equal(h.getRouting(), 'isolated');
  });

  it("returns 'unknown' when audioSession.type is empty string", async () => {
    setStubAudioSession('');
    const h = await freshHeadphones();
    assert.equal(h.getRouting(), 'unknown');
  });

  it('isOnSpeaker returns true only when routing is speaker (not unknown, not isolated)', async () => {
    setStubAudioSession('speaker');
    let h = await freshHeadphones();
    assert.equal(h.isOnSpeaker(), true);

    setStubAudioSession('headphones');
    h = await freshHeadphones();
    assert.equal(h.isOnSpeaker(), false);

    setStubAudioSession(undefined);
    h = await freshHeadphones();
    assert.equal(h.isOnSpeaker(), false);
  });
});

describe('headphones — isBargeAvailable() SSOT decision matrix', () => {
  it('realtime + speaker → available (WebRTC AEC engages)', async () => {
    setStubAudioSession('speaker');
    const h = await freshHeadphones();
    const r = h.isBargeAvailable('realtime');
    assert.equal(r.available, true);
    assert.equal(r.reason, '');
  });

  it('realtime + headphones → available', async () => {
    setStubAudioSession('headphones');
    const h = await freshHeadphones();
    assert.equal(h.isBargeAvailable('realtime').available, true);
  });

  it('realtime + unknown (Mac) → available', async () => {
    setStubAudioSession(undefined);
    const h = await freshHeadphones();
    assert.equal(h.isBargeAvailable('realtime').available, true);
  });

  it('turnbased + speaker → UNAVAILABLE with explanatory reason', async () => {
    setStubAudioSession('speaker');
    const h = await freshHeadphones();
    const r = h.isBargeAvailable('turnbased');
    assert.equal(r.available, false);
    assert.match(r.reason, /speaker/i);
    assert.match(r.reason, /headphones/i);  // mentions the workaround
  });

  it('turnbased + headphones → available', async () => {
    setStubAudioSession('headphones');
    const h = await freshHeadphones();
    assert.equal(h.isBargeAvailable('turnbased').available, true);
  });

  it('turnbased + bluetooth → available', async () => {
    setStubAudioSession('bluetooth');
    const h = await freshHeadphones();
    assert.equal(h.isBargeAvailable('turnbased').available, true);
  });

  it('turnbased + unknown (Mac demo) → available (lets user discover via hint)', async () => {
    setStubAudioSession(undefined);
    const h = await freshHeadphones();
    assert.equal(h.isBargeAvailable('turnbased').available, true);
  });
});
