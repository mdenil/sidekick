/**
 * @fileoverview Smoke test for BrowserSTTProvider — verifies the Web
 * Speech onresult/onend events translate into TranscriptEvents that
 * match what dictate.ts's cursor-aware splice machine expects from the
 * WebRTC bridge.
 *
 * Critical invariants:
 *   - interim onresult → { is_final: false, role: 'user', text }
 *   - final onresult   → { is_final: true,  role: 'user', text }
 *   - SR.onend after a content-final → synthetic empty-text final
 *     (utterance-end). dictate.ts uses this to advance cursor + add
 *     trailing space.
 *   - SR.onend without a preceding content-final → no synthetic event
 *     (the utterance was already closed or empty).
 *   - isSupported() detects vendor-prefixed webkitSpeechRecognition.
 *   - Auto-restart kicks in on onend unless stop() was called.
 *   - start() throws when SR ctor is missing.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub the global window before importing the module — BrowserSTTProvider
// reads `window.SpeechRecognition` at start() time, AND isSupported() is
// called even before construct.
function ensureWindow() {
  if (!(globalThis as any).window) (globalThis as any).window = {};
}
ensureWindow();

let lastInstance: any = null;
class StubSR {
  continuous = false;
  interimResults = false;
  lang = 'en-US';
  onresult: any = null;
  onend: any = null;
  onerror: any = null;
  onstart: any = null;
  startCalls = 0;
  abortCalls = 0;
  constructor() {
    lastInstance = this;
  }
  start() { this.startCalls++; if (this.onstart) this.onstart({}); }
  stop() { if (this.onend) this.onend({}); }
  abort() { this.abortCalls++; }
}

// Helper: build an onresult event the same shape Web Speech delivers.
function makeResultEvent(segments: { transcript: string; isFinal: boolean }[], resultIndex = 0) {
  const results = segments.map(s => {
    const list: any = [{ transcript: s.transcript, confidence: 0.9 }];
    list.isFinal = s.isFinal;
    return list;
  });
  (results as any).length = segments.length;
  return { resultIndex, results };
}

// Pull the class directly. pickStreamingProvider() also lives in this
// module but it imports settings.ts + realtime.ts — out of scope for a
// pure-state-machine smoke test.
import { BrowserSTTProvider, isSupported } from '../src/audio/streaming/browserDictate.ts';

describe('BrowserSTTProvider — Web Speech mapping', () => {
  let provider: BrowserSTTProvider;

  beforeEach(() => {
    (globalThis as any).window.SpeechRecognition = StubSR;
    (globalThis as any).window.webkitSpeechRecognition = StubSR;
    lastInstance = null;
    provider = new BrowserSTTProvider();
  });
  afterEach(async () => {
    await provider.stop();
    delete (globalThis as any).window.SpeechRecognition;
    delete (globalThis as any).window.webkitSpeechRecognition;
  });

  it('isSupported false when both ctors missing', () => {
    delete (globalThis as any).window.SpeechRecognition;
    delete (globalThis as any).window.webkitSpeechRecognition;
    assert.equal(isSupported(), false);
  });

  it('isSupported true with webkit prefix only (Safari path)', () => {
    delete (globalThis as any).window.SpeechRecognition;
    (globalThis as any).window.webkitSpeechRecognition = StubSR;
    assert.equal(isSupported(), true);
  });

  it('start() throws when SR ctor is missing', async () => {
    delete (globalThis as any).window.SpeechRecognition;
    delete (globalThis as any).window.webkitSpeechRecognition;
    await assert.rejects(() => provider.start(), /not supported/);
  });

  it('start() constructs SR with continuous + interimResults', async () => {
    await provider.start();
    assert.ok(lastInstance);
    assert.equal(lastInstance.continuous, true);
    assert.equal(lastInstance.interimResults, true);
    assert.equal(lastInstance.startCalls, 1);
  });

  it('interim onresult emits is_final=false transcript event', async () => {
    const events: any[] = [];
    provider.onTranscript((ev) => events.push(ev));
    await provider.start();
    lastInstance.onresult(makeResultEvent([{ transcript: 'hello world', isFinal: false }]));
    assert.equal(events.length, 1);
    assert.equal(events[0].is_final, false);
    assert.equal(events[0].role, 'user');
    assert.equal(events[0].text, 'hello world');
  });

  it('final onresult emits is_final=true transcript event', async () => {
    const events: any[] = [];
    provider.onTranscript((ev) => events.push(ev));
    await provider.start();
    lastInstance.onresult(makeResultEvent([{ transcript: 'hello world', isFinal: true }]));
    assert.equal(events.length, 1);
    assert.equal(events[0].is_final, true);
    assert.equal(events[0].text, 'hello world');
  });

  it('onend after content-final synthesizes empty-text utterance-end', async () => {
    const events: any[] = [];
    provider.onTranscript((ev) => events.push(ev));
    await provider.start();
    lastInstance.onresult(makeResultEvent([{ transcript: 'hello', isFinal: true }]));
    // Trigger onend (Safari ~30s session kill, or natural end).
    lastInstance.onend({});
    // Two events: the content-final, then the synthetic utterance-end.
    assert.equal(events.length, 2);
    assert.equal(events[1].is_final, true);
    assert.equal(events[1].text, '');
    assert.equal(events[1].role, 'user');
  });

  it('onend without preceding final does NOT synthesize utterance-end', async () => {
    const events: any[] = [];
    provider.onTranscript((ev) => events.push(ev));
    await provider.start();
    // Only an interim, no final.
    lastInstance.onresult(makeResultEvent([{ transcript: 'hello', isFinal: false }]));
    lastInstance.onend({});
    assert.equal(events.length, 1);
    assert.equal(events[0].is_final, false);
  });

  it('auto-restarts SR on onend (Safari ~30s kill recovery)', async (t) => {
    await provider.start();
    const firstInstance = lastInstance;
    // Simulate Safari killing the session.
    firstInstance.onend({});
    // Auto-restart fires after a 200ms guard delay. Wait it out.
    await new Promise(r => setTimeout(r, 250));
    // A fresh SR was constructed and start() called on it.
    assert.notEqual(lastInstance, firstInstance);
    assert.equal(lastInstance.startCalls, 1);
  });

  it('stop() prevents auto-restart', async () => {
    await provider.start();
    const firstInstance = lastInstance;
    await provider.stop();
    // Even if onend somehow fires after stop, we shouldn't restart.
    firstInstance.onend({});
    await new Promise(r => setTimeout(r, 250));
    // No new instance built post-stop.
    assert.equal(lastInstance, firstInstance);
  });

  it('start() is idempotent — second call while running is a no-op', async () => {
    await provider.start();
    const firstInstance = lastInstance;
    await provider.start();
    assert.equal(lastInstance, firstInstance);
    assert.equal(firstInstance.startCalls, 1);
  });

  it('multi-segment onresult emits one event per segment', async () => {
    const events: any[] = [];
    provider.onTranscript((ev) => events.push(ev));
    await provider.start();
    lastInstance.onresult(makeResultEvent([
      { transcript: 'first', isFinal: true },
      { transcript: 'second', isFinal: false },
    ]));
    assert.equal(events.length, 2);
    assert.equal(events[0].is_final, true);
    assert.equal(events[0].text, 'first');
    assert.equal(events[1].is_final, false);
    assert.equal(events[1].text, 'second');
  });

  it('permanent error (not-allowed) suppresses auto-restart', async () => {
    await provider.start();
    const firstInstance = lastInstance;
    firstInstance.onerror({ error: 'not-allowed' });
    firstInstance.onend({});
    await new Promise(r => setTimeout(r, 250));
    assert.equal(lastInstance, firstInstance);
  });
});
