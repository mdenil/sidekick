/**
 * @fileoverview Phase 1 — virtualizer pure-math tests.
 *
 * Covers `createHeightCache`, `computeVisibleWindow`, `computeAnchor`,
 * and `scrollTopForAnchor`. All four functions are pure (no DOM, no
 * module state), so we exercise the math exhaustively without
 * standing up a browser.
 *
 * The DOM-binding `bindVirtualizer` factory is covered by the
 * Playwright dev-test in `scripts/dev-tests/virtualizer-window-math.mjs`
 * (which can hit a real headless browser); these tests only validate
 * the windowing/anchor math the factory delegates to.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHeightCache,
  computeVisibleWindow,
  computeAnchor,
  scrollTopForAnchor,
  type SavedAnchor,
} from './virtualizer.ts';
import type { BubbleSpec } from './types.ts';

function mkSpec(i: number, kind: BubbleSpec['kind'] = 'user'): BubbleSpec {
  if (kind === 'user') {
    return { kind: 'user', key: `k-${i}`, text: `u-${i}`, timestamp: i };
  }
  if (kind === 'assistant') {
    return { kind: 'assistant', key: `k-${i}`, text: `a-${i}`, timestamp: i };
  }
  if (kind === 'notification') {
    return { kind: 'notification', key: `k-${i}`, text: `n-${i}`, timestamp: i, notificationKind: 'cron' };
  }
  return { kind: 'activityRow', key: `k-${i}`, timestamp: i, tools: [], complete: true };
}

function mkSpecs(n: number, kind: BubbleSpec['kind'] = 'user'): BubbleSpec[] {
  return Array.from({ length: n }, (_, i) => mkSpec(i, kind));
}

describe('createHeightCache', () => {
  it('returns per-kind default for unmeasured keys', () => {
    const c = createHeightCache();
    assert.equal(c.get('any', 'user'), 80);
    assert.equal(c.get('any', 'assistant'), 160);
    assert.equal(c.get('any', 'notification'), 60);
    assert.equal(c.get('any', 'activityRow'), 80);
  });

  it('returns measured value once set, flooring + clamping ≥0', () => {
    const c = createHeightCache();
    c.set('x', 123.7);
    assert.equal(c.get('x', 'assistant'), 123);
    c.set('y', -50);
    assert.equal(c.get('y', 'user'), 0);
  });

  it('delete removes a measurement back to the default', () => {
    const c = createHeightCache();
    c.set('x', 500);
    assert.equal(c.get('x', 'user'), 500);
    c.delete('x');
    assert.equal(c.get('x', 'user'), 80);
  });

  it('clear drops all measurements', () => {
    const c = createHeightCache();
    c.set('a', 100);
    c.set('b', 200);
    c.clear();
    assert.equal(c.get('a', 'user'), 80);
    assert.equal(c.get('b', 'assistant'), 160);
  });

  it('entries iterates only measured pairs', () => {
    const c = createHeightCache();
    c.set('a', 100);
    c.set('b', 200);
    assert.deepEqual(Array.from(c.entries()).sort(), [['a', 100], ['b', 200]]);
  });
});

describe('computeVisibleWindow', () => {
  it('empty specs → all zeros', () => {
    const c = createHeightCache();
    const w = computeVisibleWindow({
      specs: [], cache: c, scrollTop: 0, viewportHeight: 500,
    });
    assert.deepEqual(w, { visibleFrom: 0, visibleTo: 0, topSpacerPx: 0, bottomSpacerPx: 0 });
  });

  it('single spec fully inside viewport → visible=[0,1)', () => {
    const c = createHeightCache();
    const w = computeVisibleWindow({
      specs: [mkSpec(0, 'user')], cache: c, scrollTop: 0, viewportHeight: 500,
    });
    assert.equal(w.visibleFrom, 0);
    assert.equal(w.visibleTo, 1);
    assert.equal(w.topSpacerPx, 0);
    assert.equal(w.bottomSpacerPx, 0);
  });

  it('scrollTop=0, viewport fits N user specs at 80px → strict visible [0..ceil(viewport/80))', () => {
    // 10 specs × 80px = 800px total. Viewport 200px → first 3 strictly
    // visible (0..240px range covers indices 0,1,2). Overscan default 6
    // → visible[0..min(10, 3+6))=[0,9), topSpacer=0, bottomSpacer=80.
    const c = createHeightCache();
    const w = computeVisibleWindow({
      specs: mkSpecs(10), cache: c, scrollTop: 0, viewportHeight: 200,
    });
    assert.equal(w.visibleFrom, 0);
    assert.equal(w.visibleTo, 9);
    assert.equal(w.topSpacerPx, 0);
    assert.equal(w.bottomSpacerPx, 80);  // last 1 spec × 80
  });

  it('scrollTop mid-chat → window slides; spacers reflect heights above/below', () => {
    // 100 user specs × 80px = 8000px. viewport=500. scrollTop=3200.
    // First spec whose bottom > 3200 is spec[40] (top 3200, bottom 3280).
    // Viewport bottom = 3700. First spec with top ≥ 3700 is spec[47]
    // (top 3760). With overscan=6: visible=[34, 53).
    const c = createHeightCache();
    const w = computeVisibleWindow({
      specs: mkSpecs(100), cache: c, scrollTop: 3200, viewportHeight: 500,
    });
    assert.equal(w.visibleFrom, 34);
    assert.equal(w.visibleTo, 53);
    assert.equal(w.topSpacerPx, 34 * 80);  // 2720
    assert.equal(w.bottomSpacerPx, (100 - 53) * 80);  // 3760
  });

  it('mixed kinds use per-kind defaults', () => {
    // [user(80), assistant(160), notification(60), activityRow(80)]
    // total=380. viewport=200, scrollTop=0. First past viewport bottom:
    // user.bottom=80, assistant.bottom=240 — so first beyond viewport
    // is index 2 (notification, top 240). visible strict [0..2). With
    // overscan=6 → [0, min(4, 2+6))=[0,4).
    const specs = [
      mkSpec(0, 'user'),
      mkSpec(1, 'assistant'),
      mkSpec(2, 'notification'),
      mkSpec(3, 'activityRow'),
    ];
    const c = createHeightCache();
    const w = computeVisibleWindow({
      specs, cache: c, scrollTop: 0, viewportHeight: 200,
    });
    assert.equal(w.visibleFrom, 0);
    assert.equal(w.visibleTo, 4);
    assert.equal(w.topSpacerPx, 0);
    assert.equal(w.bottomSpacerPx, 0);
  });

  it('custom heights override defaults', () => {
    const c = createHeightCache();
    const specs = mkSpecs(5);
    c.set('k-0', 500);  // huge first spec
    const w = computeVisibleWindow({
      specs, cache: c, scrollTop: 0, viewportHeight: 200,
    });
    // spec[0] alone is 500px and fills the viewport. Strict visible=[0,1).
    // overscan adds 6 → visibleTo=min(5, 1+6)=5.
    assert.equal(w.visibleFrom, 0);
    assert.equal(w.visibleTo, 5);
  });

  it('overscan=0 leaves only strictly-visible specs', () => {
    const c = createHeightCache();
    const w = computeVisibleWindow({
      specs: mkSpecs(100), cache: c, scrollTop: 3200, viewportHeight: 500, overscan: 0,
    });
    assert.equal(w.visibleFrom, 40);
    assert.equal(w.visibleTo, 47);
  });

  it('scrollTop past total content clamps to trailing overscan window', () => {
    // 10 specs × 80 = 800. scrollTop=10000 is past everything.
    // firstVisible stays -1 → falls to specs.length=10.
    // firstAfter stays specs.length=10.
    // With overscan=6: visibleFrom = max(0, 10-6)=4, visibleTo=min(10, 10+6)=10.
    const c = createHeightCache();
    const w = computeVisibleWindow({
      specs: mkSpecs(10), cache: c, scrollTop: 10000, viewportHeight: 200,
    });
    assert.equal(w.visibleFrom, 4);
    assert.equal(w.visibleTo, 10);
  });

  it('top/bottom spacer sum + visible heights = total content height', () => {
    const c = createHeightCache();
    const specs = mkSpecs(50);
    // Vary a few heights to make sure the spacer math handles non-uniform cache.
    c.set('k-3', 200);
    c.set('k-12', 350);
    c.set('k-30', 100);
    const w = computeVisibleWindow({
      specs, cache: c, scrollTop: 1500, viewportHeight: 600,
    });
    let visiblePx = 0;
    for (let i = w.visibleFrom; i < w.visibleTo; i++) {
      visiblePx += c.get(specs[i].key, specs[i].kind);
    }
    let totalPx = 0;
    for (const s of specs) totalPx += c.get(s.key, s.kind);
    assert.equal(w.topSpacerPx + visiblePx + w.bottomSpacerPx, totalPx);
  });
});

describe('computeAnchor', () => {
  it('empty specs → null', () => {
    assert.equal(
      computeAnchor({ specs: [], cache: createHeightCache(), scrollTop: 0 }),
      null,
    );
  });

  it('scrollTop=0 → first spec, offsetPx=0', () => {
    const a = computeAnchor({
      specs: mkSpecs(10), cache: createHeightCache(), scrollTop: 0,
    });
    assert.deepEqual(a, { key: 'k-0', offsetPx: 0 });
  });

  it('scrollTop mid-spec → that spec, offsetPx > 0', () => {
    // 10 user specs × 80 = 800. scrollTop=150 lands inside spec[1]
    // (top 80, bottom 160). offsetPx = 150 - 80 = 70.
    const a = computeAnchor({
      specs: mkSpecs(10), cache: createHeightCache(), scrollTop: 150,
    });
    assert.deepEqual(a, { key: 'k-1', offsetPx: 70 });
  });

  it('scrollTop at exact spec boundary → that spec, offsetPx=0', () => {
    const a = computeAnchor({
      specs: mkSpecs(10), cache: createHeightCache(), scrollTop: 240,
    });
    // 240 is the boundary between spec[2] (160..240) and spec[3] (240..320).
    // computeAnchor picks the FIRST spec whose top+h > scrollTop —
    // spec[2] (80+80=160, NOT > 240) — spec[3] (240+80=320 > 240, YES).
    // So anchor is spec[3] at offset 0.
    assert.deepEqual(a, { key: 'k-3', offsetPx: 0 });
  });

  it('scrollTop past total → last spec, offsetPx=0', () => {
    const a = computeAnchor({
      specs: mkSpecs(10), cache: createHeightCache(), scrollTop: 99999,
    });
    assert.deepEqual(a, { key: 'k-9', offsetPx: 0 });
  });
});

describe('scrollTopForAnchor', () => {
  it('first spec, offsetPx=0 → scrollTop=0', () => {
    const top = scrollTopForAnchor({
      specs: mkSpecs(10),
      cache: createHeightCache(),
      anchor: { key: 'k-0', offsetPx: 0 },
    });
    assert.equal(top, 0);
  });

  it('mid spec, offsetPx=N → cumulative-top + N', () => {
    // spec[3] top = 240. anchor.offsetPx = 50 → 290.
    const top = scrollTopForAnchor({
      specs: mkSpecs(10),
      cache: createHeightCache(),
      anchor: { key: 'k-3', offsetPx: 50 },
    });
    assert.equal(top, 290);
  });

  it('anchor key missing → null', () => {
    const top = scrollTopForAnchor({
      specs: mkSpecs(10),
      cache: createHeightCache(),
      anchor: { key: 'nope', offsetPx: 0 },
    });
    assert.equal(top, null);
  });

  it('clamps to ≥0 for negative resulting scrollTop', () => {
    const top = scrollTopForAnchor({
      specs: mkSpecs(10),
      cache: createHeightCache(),
      anchor: { key: 'k-0', offsetPx: -1000 },
    });
    assert.equal(top, 0);
  });
});

describe('anchor round-trip', () => {
  it('compute then restore returns the original scrollTop', () => {
    // Set up irregular heights so the round-trip exercises non-default cache.
    const specs = mkSpecs(20);
    const c = createHeightCache();
    c.set('k-3', 200);
    c.set('k-7', 350);
    c.set('k-12', 90);
    // Several scrollTops across the chat.
    for (const scrollTop of [0, 100, 250, 500, 1000, 1500, 1700]) {
      const anchor = computeAnchor({ specs, cache: c, scrollTop });
      assert.ok(anchor, `null anchor at scrollTop=${scrollTop}`);
      const restored = scrollTopForAnchor({ specs, cache: c, anchor: anchor as SavedAnchor });
      assert.equal(restored, scrollTop, `round-trip failed at scrollTop=${scrollTop}`);
    }
  });

  it('round-trip preserves position when heights ELSEWHERE change', () => {
    // The anchor invariant: if heights of OTHER specs change between
    // save and restore, the anchored spec's position-relative-to-
    // viewport stays the same. The scrollTop value itself shifts to
    // accommodate, but the user sees the same content.
    const specs = mkSpecs(20);
    const c1 = createHeightCache();
    // Save anchor at scrollTop=500 → lands inside spec[6] (top 480, +20).
    const anchor = computeAnchor({ specs, cache: c1, scrollTop: 500 });
    assert.deepEqual(anchor, { key: 'k-6', offsetPx: 20 });

    // Now imagine some early specs grow (e.g. image loaded, content
    // expanded). Restore site reads new cache.
    const c2 = createHeightCache();
    c2.set('k-2', 300);  // was 80, now 300 (extra 220px above the anchor)
    const restored = scrollTopForAnchor({ specs, cache: c2, anchor: anchor! });
    // spec[6] top in c2 = 5 × 80 + 300 = 700. anchor.offsetPx = 20 → 720.
    // (Was 500 in c1; now 720 in c2. Reason: 220px of new content above.)
    assert.equal(restored, 720);
  });
});
