// Regression guard for the iOS activity-badge mispositioning bug
// (Jonathan, 2026-06-01, on a flight): the green unread "N" chip on the
// mobile Activity toolbar button rendered floating at the viewport's
// top-right corner instead of pinned to the bell icon.
//
// Root cause: `.pin-count-banner` is `position:absolute; top:-2px;
// right:-2px`, so it positions against its nearest positioned ancestor.
// The CSS only set `position:relative` on `#btn-pin-drawer`, not on
// `#btn-activity-drawer` — so the activity badge had NO positioned
// ancestor and escaped to the initial containing block (the viewport).
// Fix (604b63a): add `#btn-activity-drawer` to the position:relative rule.
//
// This smoke shows the badge (the CSS position is structural and
// independent of the count logic, which notifications-badge-tracking
// already covers) and asserts its rect is anchored to the button's
// top-right corner — NOT escaped to the viewport. The pre-fix CSS puts
// the badge's top at ~-2px (above the toolbar) while the button sits
// well below the top edge, so the top-alignment check is the
// discriminator that fails on the regression.
//
// MOBILE=true → 390x844 + mobile UA so the `.mobile-only` toolbar
// buttons get `display:flex` (they're `display:none` on desktop).

import { waitForReady, assert } from './lib.mjs';

export const NAME = 'badge-geometry';
export const DESCRIPTION = 'activity drawer count badge stays pinned to its toolbar button (not floating at viewport top-right) on mobile';
export const STATUS = 'implemented';
export const BACKEND = 'mocked';
export const MOBILE = true;

export default async function run({ page, log }) {
  await waitForReady(page);

  // Force the badge visible + measure both rects. We toggle the DOM
  // directly rather than driving the unread-count path because the CSS
  // position rule is what we're pinning, not the count wiring.
  const geo = await page.evaluate(() => {
    const btn = document.getElementById('btn-activity-drawer');
    const badge = document.getElementById('activity-drawer-count');
    if (!btn) return { err: 'btn-activity-drawer not found' };
    if (!badge) return { err: 'activity-drawer-count not found' };
    badge.hidden = false;
    badge.textContent = '2';
    const b = btn.getBoundingClientRect();
    const g = badge.getBoundingClientRect();
    return {
      btn: { top: b.top, right: b.right, bottom: b.bottom, left: b.left, w: b.width, h: b.height },
      badge: { top: g.top, right: g.right, bottom: g.bottom, left: g.left, w: g.width, h: g.height },
    };
  });

  assert(!geo.err, `setup: ${geo.err}`);
  log(`button rect: ${JSON.stringify(geo.btn)}`);
  log(`badge  rect: ${JSON.stringify(geo.badge)}`);

  // The toolbar button must actually be laid out (mobile-only display:flex).
  assert(geo.btn.w > 0 && geo.btn.h > 0,
    `activity button not laid out (rect ${JSON.stringify(geo.btn)}) — is the mobile toolbar rendered?`);
  assert(geo.badge.w > 0 && geo.badge.h > 0,
    `badge not laid out (rect ${JSON.stringify(geo.badge)})`);

  // Anchored to the button's top-right corner. The fix's CSS puts the
  // badge at top:-2px / right:-2px relative to the button, so each edge
  // sits within a few px of the button's corner. A generous 8px window
  // absorbs the -2px overhang + sub-pixel rounding while still being far
  // tighter than the regression (escaped badge.top ≈ -2 vs a button that
  // sits a full toolbar-height below the viewport top).
  const TOL = 8;
  const dRight = Math.abs(geo.badge.right - geo.btn.right);
  const dTop = Math.abs(geo.badge.top - geo.btn.top);
  log(`Δright=${dRight.toFixed(1)}px Δtop=${dTop.toFixed(1)}px (tolerance ${TOL}px)`);

  assert(dTop <= TOL,
    `badge escaped vertically: badge.top=${geo.badge.top.toFixed(1)} vs button.top=${geo.btn.top.toFixed(1)} ` +
    `(Δ${dTop.toFixed(1)}px > ${TOL}px). On the pre-fix CSS the badge floats to the viewport top.`);
  assert(dRight <= TOL,
    `badge escaped horizontally: badge.right=${geo.badge.right.toFixed(1)} vs button.right=${geo.btn.right.toFixed(1)} ` +
    `(Δ${dRight.toFixed(1)}px > ${TOL}px).`);

  log('PASS: activity badge anchored to its toolbar button.');
}
