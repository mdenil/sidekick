// Pin sidebarSwipe's gating. Two field bugs shaped this:
//
//   2026-05-09: "swiping right inside the composer textarea opens
//   the drawer, can't text-select." The pre-fix gesture applied
//   `body.swipe-active` (touch-action:none) on every pointerdown
//   regardless of target, killing iOS's native text selection.
//   Fix: bail at pointerdown on inputs/sliders/h-scrollables.
//
//   2026-05-10 (8bb69e8 lazy swipe-lock): "settings-close tap →
//   any tap → freezes the UI for 2s." `body.swipe-active` was being
//   set at pointerdown and only cleared at pointerup; if pointerup
//   was missed (tap on certain regions), the class stuck and froze
//   touch-action everywhere. Fix: defer setSwipeLock(true) to the
//   commit transition inside pointermove (after MIN_DISTANCE_PX
//   horizontal motion is confirmed). Taps never set the class.
//
// Asserts (mobile viewport, drawer collapsed):
//   1. pointerdown on textarea → no swipe-active (iOS native selection).
//   2. pointerdown on range slider → no swipe-active (iOS native drag).
//   3. pointerdown on body, no follow-up motion → no swipe-active.
//      This is the lazy-lock invariant — taps must NOT engage.
//   4. pointerdown on body + horizontal pointermove past MIN_DISTANCE_PX
//      → swipe-active applies. This is the ChatGPT-style open path.

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'sidebar-swipe-gate';
export const DESCRIPTION = 'Open-drawer swipe engages anywhere on screen but skips inputs/sliders/h-scrollables';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';

export default async function run({ page, log }) {
  // Mobile breakpoint is <700px; sidebarSwipe.ts no-ops above that.
  // The smoke runner's default 1280x800 viewport bypasses the entire
  // gesture, so resize to a phone-shaped viewport for this test.
  await page.setViewportSize({ width: 390, height: 844 });

  await waitForReady(page);

  const swipeActive = () => page.evaluate(() => document.body.classList.contains('swipe-active'));

  // Helper: dispatch a real PointerEvent at given coords with optional
  // target selector. Mirrors what a finger touch would produce.
  const fireDown = async (clientX, clientY, sel) => {
    await page.evaluate(({ clientX, clientY, sel }) => {
      const el = sel ? document.querySelector(sel) : document.body;
      if (!el) throw new Error(`no element for selector ${sel}`);
      const evt = new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, isPrimary: true,
        pointerId: 1, pointerType: 'touch',
        clientX, clientY,
      });
      el.dispatchEvent(evt);
    }, { clientX, clientY, sel });
  };

  // pointermove dispatch — sidebarSwipe listens on `window` for these,
  // so dispatch on document.body and let bubbling carry it up. The
  // commit transition fires once dx²+dy² ≥ MIN_DISTANCE_PX² (currently
  // 30² = 900) AND |dx| > |dy| AND direction matches intent.
  const fireMove = async (clientX, clientY) => {
    await page.evaluate(({ clientX, clientY }) => {
      const evt = new PointerEvent('pointermove', {
        bubbles: true, cancelable: true, isPrimary: true,
        pointerId: 1, pointerType: 'touch',
        clientX, clientY,
      });
      document.body.dispatchEvent(evt);
    }, { clientX, clientY });
  };

  const fireUp = async () => {
    await page.evaluate(() => {
      const evt = new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, isPrimary: true,
        pointerId: 1, pointerType: 'touch',
        clientX: 0, clientY: 0,
      });
      document.body.dispatchEvent(evt);
    });
  };

  // ── Case 1: pointerdown on textarea (would-be-but-no) ─────────────
  // The textarea-target bail at pointerdown must hold regardless of
  // x position — even if a subsequent move would cross MIN_DISTANCE_PX,
  // intent was never set so the move handler short-circuits.
  await fireDown(200, 420, '#composer-input');
  assert(!(await swipeActive()),
    'pointerdown on composer textarea should NOT apply swipe-active');
  await fireUp();
  log('textarea pointerdown: gesture inactive ✓');

  // ── Case 2: pointerdown on a range slider ─────────────────────────
  await page.evaluate(() => {
    const r = document.createElement('input');
    r.type = 'range'; r.id = 'smoke-test-slider';
    r.style.cssText = 'position:fixed;left:50px;top:60%;width:200px;z-index:9999';
    document.body.appendChild(r);
  });
  await fireDown(150, 530, '#smoke-test-slider');
  assert(!(await swipeActive()),
    'pointerdown on range slider should NOT apply swipe-active');
  await fireUp();
  log('range-slider pointerdown: gesture inactive ✓');

  // ── Case 3: pointerdown on body without follow-up motion ──────────
  // Lazy-lock invariant (8bb69e8): a tap must NEVER apply swipe-active.
  // The pre-fix code did this and a missed pointerup left the class
  // stuck, freezing touch-action site-wide for ~2s.
  await page.evaluate(() => {
    document.getElementById('smoke-test-slider')?.remove();
  });
  await fireDown(200, 300, null);
  assert(!(await swipeActive()),
    'bare pointerdown on body should NOT apply swipe-active (taps must not engage)');
  await fireUp();
  log('bare body pointerdown (tap): no swipe-active ✓');

  // ── Case 4: body pointerdown + horizontal motion past MIN_DISTANCE_PX
  // ────────────────────────────────────────────────────────────────────
  // This is the ChatGPT-style open-drawer gesture. swipe-active should
  // apply once the move handler confirms a horizontal-dominant swipe of
  // ≥ 30px in the opening direction (positive dx when collapsed).
  await fireDown(200, 300, null);
  // Two-step move so onPointerMove sees a delta first, then crosses the
  // threshold. Real fingers produce many pointermoves; one 40px jump
  // is enough for the assertion.
  await fireMove(240, 305);   // dx=40, dy=5 → past threshold, horizontal-dominant
  assert(await swipeActive(),
    'pointerdown on body + horizontal pointermove > MIN_DISTANCE_PX SHOULD apply swipe-active');
  await fireUp();
  await page.waitForFunction(() => !document.body.classList.contains('swipe-active'),
    null, { timeout: 1000 });
  log('body pointerdown + horizontal move: gesture engaged at commit then released ✓');
}
