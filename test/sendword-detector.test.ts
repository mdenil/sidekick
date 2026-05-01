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

import * as sendword from '../src/audio/sendwordDetector.ts';

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
