/**
 * @fileoverview Tests for the shared handsfree policy module
 * (matchSendword + SilenceWindow). The pre-existing
 * test/commit-word.test.ts pinned the inline regex; these tests pin
 * the same semantics on the extracted helper, plus the
 * SilenceWindow class.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { matchSendword, SilenceWindow } from '../src/audio/shared/handsfree.ts';

describe('matchSendword', () => {
  it('matches bare "over"', () => {
    const r = matchSendword('over', 'over');
    assert.equal(r.matched, true);
    assert.equal(r.matched && r.cleaned, '');
  });

  it('matches "Over." case-insensitively', () => {
    const r = matchSendword('Over.', 'over');
    assert.equal(r.matched, true);
    assert.equal(r.matched && r.cleaned, '');
  });

  it('matches "over" at end of sentence', () => {
    const r = matchSendword('check it out. Over.', 'over');
    assert.equal(r.matched, true);
    assert.equal(r.matched && r.cleaned, 'check it out.');
  });

  it('strips trailing "over" and keeps content', () => {
    const r = matchSendword('Hand it over', 'over');
    assert.equal(r.matched, true);
    assert.equal(r.matched && r.cleaned, 'Hand it');
  });

  it('matches LAST "over" in sentence with multiple', () => {
    const r = matchSendword('I went over to the store and the trip is over', 'over');
    assert.equal(r.matched, true);
    assert.equal(r.matched && r.cleaned, 'I went over to the store and the trip is');
  });

  it('handles "over" followed by comma then "over"', () => {
    const r = matchSendword('The game is over, over.', 'over');
    assert.equal(r.matched, true);
    assert.equal(r.matched && r.cleaned, 'The game is over,');
  });

  it('does NOT match "moreover"', () => {
    const r = matchSendword('Moreover I think', 'over');
    assert.equal(r.matched, false);
  });

  it('does NOT match "takeover"', () => {
    const r = matchSendword('the takeover is complete', 'over');
    assert.equal(r.matched, false);
  });

  it('matches "takeover is complete over"', () => {
    const r = matchSendword('the takeover is complete over', 'over');
    assert.equal(r.matched, true);
    assert.equal(r.matched && r.cleaned, 'the takeover is complete');
  });

  it('does NOT match mid-sentence "over"', () => {
    const r = matchSendword('I went over the bridge today', 'over');
    assert.equal(r.matched, false);
  });

  it('handles "over" with trailing question mark', () => {
    const r = matchSendword('is it over?', 'over');
    assert.equal(r.matched, true);
    assert.equal(r.matched && r.cleaned, 'is it');
  });

  it('works with multi-word phrase "send it"', () => {
    const r = matchSendword('here is my message send it', 'send it');
    assert.equal(r.matched, true);
    assert.equal(r.matched && r.cleaned, 'here is my message');
  });

  it('works with custom phrase "roger"', () => {
    const r = matchSendword('got it, roger', 'roger');
    assert.equal(r.matched, true);
    assert.equal(r.matched && r.cleaned, 'got it,');
  });

  it('custom phrase does not match partial', () => {
    const r = matchSendword('the roger rabbit movie', 'roger');
    assert.equal(r.matched, false);
  });

  it('empty phrase always returns matched=false', () => {
    assert.equal(matchSendword('over', '').matched, false);
    assert.equal(matchSendword('anything at all', '   ').matched, false);
  });

  it('empty input returns matched=false', () => {
    assert.equal(matchSendword('', 'over').matched, false);
  });

  it('escapes regex metacharacters in the phrase', () => {
    // A phrase like "go+stop" contains a regex quantifier `+`. Without
    // escaping, the regex would be parsed as "go" (one or more) "stop".
    // After escaping, the literal phrase "go+stop" matches only itself.
    const r1 = matchSendword('done go+stop', 'go+stop');
    assert.equal(r1.matched, true);
    assert.equal(r1.matched && r1.cleaned, 'done');
    // "goo+stop" / "goostop" should NOT match — the literal "go+stop"
    // didn't appear; the unescaped regex would have matched.
    const r2 = matchSendword('done goo+stop', 'go+stop');
    assert.equal(r2.matched, false);
  });
});

describe('SilenceWindow', () => {
  it('does not expire immediately', () => {
    const t0 = 1_000_000;
    const w = new SilenceWindow(2, t0);
    assert.equal(w.expired(t0), false);
    assert.equal(w.expired(t0 + 1_000), false);
  });

  it('expires after silenceSec elapses', () => {
    const t0 = 1_000_000;
    const w = new SilenceWindow(2, t0);
    assert.equal(w.expired(t0 + 1_999), false);
    assert.equal(w.expired(t0 + 2_000), true);
    assert.equal(w.expired(t0 + 5_000), true);
  });

  it('noteVoice resets the clock', () => {
    const t0 = 1_000_000;
    const w = new SilenceWindow(2, t0);
    w.noteVoice(t0 + 1_500);
    assert.equal(w.expired(t0 + 3_499), false);
    assert.equal(w.expired(t0 + 3_500), true);
  });

  it('reset is an alias for noteVoice', () => {
    const t0 = 1_000_000;
    const w = new SilenceWindow(2, t0);
    w.reset(t0 + 1_000);
    assert.equal(w.expired(t0 + 2_999), false);
    assert.equal(w.expired(t0 + 3_000), true);
  });

  it('silenceSec=0 never expires (sendword-only mode)', () => {
    const t0 = 1_000_000;
    const w = new SilenceWindow(0, t0);
    assert.equal(w.expired(t0 + 60_000), false);
    assert.equal(w.expired(t0 + 600_000), false);
  });

  it('setThreshold updates the window live', () => {
    const t0 = 1_000_000;
    const w = new SilenceWindow(10, t0);
    assert.equal(w.expired(t0 + 5_000), false);
    w.setThreshold(2);
    assert.equal(w.expired(t0 + 5_000), true);
    w.setThreshold(0);
    assert.equal(w.expired(t0 + 600_000), false);
  });

  it('msSinceVoice reports elapsed ms', () => {
    const t0 = 1_000_000;
    const w = new SilenceWindow(5, t0);
    assert.equal(w.msSinceVoice(t0 + 500), 500);
    w.noteVoice(t0 + 1_000);
    assert.equal(w.msSinceVoice(t0 + 1_750), 750);
  });

  it('clamps negative silenceSec to 0', () => {
    const t0 = 1_000_000;
    const w = new SilenceWindow(-3, t0);
    assert.equal(w.expired(t0 + 60_000), false);
  });
});
