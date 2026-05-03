/**
 * @fileoverview Tests for the sendword detector — covers fail-soft on
 * unsupported SR, phrase matching against synthetic interim results,
 * auto-restart on `onend`, and clean teardown via stop().
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Stub the global window before importing the module — sendwordDetector
// reads `window.SpeechRecognition` at start() time.
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

import * as sendword from '../src/audio/turn-based/sendwordDetector.ts';

describe('sendword detector', () => {
  beforeEach(() => {
    (globalThis as any).window.SpeechRecognition = StubSR;
    (globalThis as any).window.webkitSpeechRecognition = StubSR;
    lastInstance = null;
  });
  afterEach(() => {
    sendword.stop();
    delete (globalThis as any).window.SpeechRecognition;
    delete (globalThis as any).window.webkitSpeechRecognition;
  });

  it('isSupported returns false when SR ctor missing', () => {
    delete (globalThis as any).window.SpeechRecognition;
    delete (globalThis as any).window.webkitSpeechRecognition;
    assert.equal(sendword.isSupported(), false);
  });

  it('isSupported returns true when stub SR is wired', () => {
    assert.equal(sendword.isSupported(), true);
  });

  it('start returns false when SR is unavailable (fail-soft)', () => {
    delete (globalThis as any).window.SpeechRecognition;
    delete (globalThis as any).window.webkitSpeechRecognition;
    let matched = false;
    const ok = sendword.start({
      phrase: 'over',
      onMatch: () => { matched = true; },
    });
    assert.equal(ok, false);
    assert.equal(matched, false);
  });

  it('matches phrase at end of interim result', () => {
    let matched = false;
    sendword.start({ phrase: 'over', onMatch: () => { matched = true; } });
    assert.ok(lastInstance);
    lastInstance.onresult({
      resultIndex: 0,
      results: [
        Object.assign(
          [{ transcript: 'hello over', confidence: 0.9 }],
          { isFinal: false },
        ),
      ],
    });
    assert.equal(matched, true);
  });

  it('does NOT match mid-sentence phrase', () => {
    let matched = false;
    sendword.start({ phrase: 'over', onMatch: () => { matched = true; } });
    assert.ok(lastInstance);
    lastInstance.onresult({
      resultIndex: 0,
      results: [
        Object.assign(
          [{ transcript: 'i went over to the store and grabbed milk', confidence: 0.9 }],
          { isFinal: false },
        ),
      ],
    });
    assert.equal(matched, false);
  });

  it('matches at end with trailing punctuation', () => {
    let matched = false;
    sendword.start({ phrase: 'over', onMatch: () => { matched = true; } });
    assert.ok(lastInstance);
    lastInstance.onresult({
      resultIndex: 0,
      results: [
        Object.assign(
          [{ transcript: 'all done. Over.', confidence: 0.9 }],
          { isFinal: false },
        ),
      ],
    });
    assert.equal(matched, true);
  });

  it('respects the configured phrase (custom word)', () => {
    let matched = false;
    sendword.start({ phrase: 'send', onMatch: () => { matched = true; } });
    assert.ok(lastInstance);
    lastInstance.onresult({
      resultIndex: 0,
      results: [
        Object.assign(
          [{ transcript: 'reply to mom send', confidence: 0.9 }],
          { isFinal: false },
        ),
      ],
    });
    assert.equal(matched, true);
  });

  it('stop() prevents auto-restart', () => {
    sendword.start({ phrase: 'over', onMatch: () => {} });
    const inst = lastInstance;
    assert.ok(inst);
    sendword.stop();
    // Simulate onend firing AFTER stop — should NOT build a new instance.
    inst.stop();
    // Wait one microtask + small delay for the restart timer.
    return new Promise((resolve) => {
      setTimeout(() => {
        // No new instance should have been created.
        assert.equal(lastInstance, inst);
        resolve(undefined);
      }, 250);
    });
  });
});

// ── External-source path (v0.403) ────────────────────────────────────
//
// When the caller already runs an STTProvider (Listen mode +
// streamingEngine=local — body transcription via Web Speech), the
// detector subscribes to its transcript events instead of opening a
// second SR session. These tests verify:
//
//   1. start() with `source` does NOT construct an SR instance.
//   2. transcript events from the source drive phrase matching.
//   3. assistant-role events are ignored.
//   4. stop() detaches the listener and does NOT call source.stop()
//      (the caller owns the provider's lifecycle).

class MockSttProvider {
  startCalls = 0;
  stopCalls = 0;
  unsubCalls = 0;
  listener: ((ev: any) => void) | null = null;
  async start() { this.startCalls++; }
  async stop() { this.stopCalls++; }
  onTranscript(cb: (ev: any) => void) {
    this.listener = cb;
    return () => { this.unsubCalls++; if (this.listener === cb) this.listener = null; };
  }
  emit(ev: any) { if (this.listener) this.listener(ev); }
}

describe('sendword detector — external STTProvider source', () => {
  beforeEach(() => {
    (globalThis as any).window.SpeechRecognition = StubSR;
    (globalThis as any).window.webkitSpeechRecognition = StubSR;
    lastInstance = null;
  });
  afterEach(() => {
    sendword.stop();
    delete (globalThis as any).window.SpeechRecognition;
    delete (globalThis as any).window.webkitSpeechRecognition;
  });

  it('does NOT construct a standalone SR when source is provided', () => {
    const src = new MockSttProvider();
    const ok = sendword.start({ phrase: 'over', onMatch: () => {}, source: src as any });
    assert.equal(ok, true);
    // No fresh SR instance — the constructor was never invoked.
    assert.equal(lastInstance, null);
    // We did NOT call start() on the source — caller owns its lifecycle.
    assert.equal(src.startCalls, 0);
    assert.ok(src.listener, 'detector should have subscribed to source');
  });

  it('matches phrase from source transcript events (interim)', () => {
    let matched = false;
    const src = new MockSttProvider();
    sendword.start({
      phrase: 'over',
      onMatch: () => { matched = true; },
      source: src as any,
    });
    src.emit({ type: 'transcript', text: 'hello over', is_final: false, role: 'user' });
    assert.equal(matched, true);
  });

  it('matches phrase on final transcript event', () => {
    let matched = false;
    const src = new MockSttProvider();
    sendword.start({
      phrase: 'over',
      onMatch: () => { matched = true; },
      source: src as any,
    });
    src.emit({ type: 'transcript', text: 'all done over', is_final: true, role: 'user' });
    assert.equal(matched, true);
  });

  it('ignores assistant-role events (TTS captions must not trigger sendword)', () => {
    let matched = false;
    const src = new MockSttProvider();
    sendword.start({
      phrase: 'over',
      onMatch: () => { matched = true; },
      source: src as any,
    });
    // Assistant TTS caption that happens to contain the word — must not fire.
    src.emit({ type: 'transcript', text: 'sure, sending it over', is_final: false, role: 'assistant' });
    assert.equal(matched, false);
  });

  it('ignores empty-text final (utterance-end sentinel)', () => {
    let matched = false;
    const src = new MockSttProvider();
    sendword.start({
      phrase: 'over',
      onMatch: () => { matched = true; },
      source: src as any,
    });
    src.emit({ type: 'transcript', text: '', is_final: true, role: 'user' });
    assert.equal(matched, false);
  });

  it('stop() unsubscribes but does NOT stop the source', () => {
    const src = new MockSttProvider();
    sendword.start({ phrase: 'over', onMatch: () => {}, source: src as any });
    sendword.stop();
    assert.equal(src.unsubCalls, 1, 'detector should have unsubscribed');
    assert.equal(src.stopCalls, 0, 'detector must NOT stop the source — caller owns it');
  });

  it('does not match mid-segment phrase from source', () => {
    let matched = false;
    const src = new MockSttProvider();
    sendword.start({
      phrase: 'over',
      onMatch: () => { matched = true; },
      source: src as any,
    });
    src.emit({ type: 'transcript', text: 'i went over to the store', is_final: false, role: 'user' });
    assert.equal(matched, false);
  });
});
