/**
 * @fileoverview Thin wrapper over drawerSwipe — keeps the existing
 * `sidebarSwipe.init({setExpanded, isExpanded})` call site stable
 * while routing all gesture logic through the parameterized
 * drawerSwipe module. Side='left' + exclude touches in #pin-drawer
 * (so the right drawer owns its own gestures when both are open).
 *
 * Why this still exists as its own export rather than inlining at
 * the main.ts call site: keeps the public surface short
 * (sidebarSwipe.init takes ONLY the open/close callbacks) and
 * documents that this drawer is "the left one" for future readers.
 */

import { initDrawerSwipe } from './drawerSwipe.ts';

interface SwipeOptions {
  setExpanded: (exp: boolean) => void;
  isExpanded: () => boolean;
}

export function init(opts: SwipeOptions): void {
  initDrawerSwipe({
    elementId: 'sidebar',
    side: 'left',
    defaultWidthPx: 280,
    setExpanded: opts.setExpanded,
    isExpanded: opts.isExpanded,
    // Touches inside the right drawer belong to its handler. Without
    // this exemption swipes on the pin drawer (when both open) fall
    // through to the left's open-from-anywhere path and pop the
    // sidebar behind it.
    excludeWhenTargetIn: ['#pin-drawer'],
  });
}
