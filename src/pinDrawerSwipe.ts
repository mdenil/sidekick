/**
 * @fileoverview Thin wrapper over drawerSwipe — mirrors
 * sidebarSwipe.ts but with side='right' so the math flips (opening
 * is right-to-left, closing is left-to-right).
 *
 * Uses the same parameterized core as the left sidebar so behavior
 * is guaranteed identical. The prior pin-drawer-only implementation
 * only supported close-from-inside; this wrapper gets
 * open-from-anywhere "for free" because the underlying drawerSwipe
 * handles both directions via the `direction` sign.
 */

import { initDrawerSwipe } from './drawerSwipe.ts';

interface SwipeOptions {
  setExpanded: (exp: boolean) => void;
  isExpanded: () => boolean;
}

export function initPinDrawerSwipe(opts: SwipeOptions): void {
  initDrawerSwipe({
    elementId: 'pin-drawer',
    side: 'right',
    defaultWidthPx: 320,
    setExpanded: opts.setExpanded,
    isExpanded: opts.isExpanded,
    // Touches inside the left drawer belong to its handler. Symmetric
    // exemption with sidebarSwipe's exclusion of #pin-drawer.
    excludeWhenTargetIn: ['#sidebar'],
  });
}
