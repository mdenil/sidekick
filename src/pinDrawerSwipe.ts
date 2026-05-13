/**
 * @fileoverview Swipe-to-close gesture for the right-side pin drawer
 * on mobile. Mirrors the sidebar's swipe model but focused on the
 * close direction only — the discoverable open affordance is the
 * toolbar pin button (`.mobile-only`).
 *
 * Gesture model:
 *   • Drawer must be OPEN at pointerdown. Otherwise no-op.
 *   • Touch must NOT be inside the left sidebar (its gesture handler
 *     owns that area; we yield).
 *   • Pre-commit motion is filtered same way the sidebar does it —
 *     MIN_DISTANCE_PX, |dx| > |dy|, dx > 0 (left-to-right) to count
 *     as a close gesture.
 *   • Live drag: drawer follows the finger, capped at [0, widthPx].
 *   • Release: velocity OR position past threshold snaps closed;
 *     otherwise snaps back open.
 *
 * Desktop (window.innerWidth >= 700): no-op. The pin drawer has its
 * own rail-toggle button there and full-overlay drag-to-close would
 * fight the 3-column layout.
 */

import { diag } from './util/log.ts';

const MIN_DISTANCE_PX = 30;
const VELOCITY_SNAP_PX_MS = 0.5;
const SNAP_DURATION_MS = 180;
const MOBILE_BREAKPOINT_PX = 700;

function targetOwnsHorizontalMotion(target: EventTarget | null): boolean {
  let el = target as Element | null;
  if (!el) return false;
  while (el && el !== document.body) {
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) {
      const t = el.type;
      if (t === 'range' || t === 'text' || t === 'search'
          || t === 'url' || t === 'email' || t === 'tel'
          || t === 'password' || t === 'number') return true;
    }
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    if (el instanceof HTMLElement) {
      const ox = getComputedStyle(el).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth) return true;
    }
    el = el.parentElement;
  }
  return false;
}

interface SwipeOptions {
  /** Called to close the drawer when the gesture commits. */
  close: () => void;
  /** True when the drawer is open (i.e. eligible for swipe-to-close). */
  isOpen: () => boolean;
}

export function initPinDrawerSwipe(opts: SwipeOptions): void {
  const drawerEl = document.getElementById('pin-drawer');
  if (!drawerEl) return;

  let pointerId = -1;
  let committed = false;
  let active = false;          // true once we've decided this gesture is ours
  let startX = 0, startY = 0;
  let lastX = 0, lastT = 0;
  let widthPx = 360;
  let lastVelocity = 0;

  const isMobile = () => window.innerWidth < MOBILE_BREAKPOINT_PX;
  const measureWidth = () => drawerEl.getBoundingClientRect().width || 360;

  const setInlineTransform = (translatePx: number) => {
    drawerEl.style.transition = 'none';
    drawerEl.style.transform = `translateX(${translatePx}px)`;
  };

  const snap = (closed: boolean) => {
    // closed = true → translate to +width (off-screen right). The
    // close() callback flips the .collapsed class which also sets
    // translateX(100%) via CSS; we synthesize the same end-state via
    // inline style + transition for the smooth animation, then hand
    // off to the class-based CSS.
    const target = closed ? widthPx : 0;
    drawerEl.style.transition = `transform ${SNAP_DURATION_MS}ms ease`;
    drawerEl.style.transform = `translateX(${target}px)`;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      drawerEl.removeEventListener('transitionend', onEnd);
      drawerEl.style.transform = '';
      drawerEl.style.transition = '';
      if (closed) opts.close();
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName === 'transform') cleanup();
    };
    drawerEl.addEventListener('transitionend', onEnd);
    setTimeout(cleanup, SNAP_DURATION_MS + 60);
  };

  const reset = () => {
    pointerId = -1;
    committed = false;
    active = false;
    lastVelocity = 0;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (active) return;
    if (!isMobile()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!opts.isOpen()) return;                  // drawer must be open
    // Sidebar's own gesture owns the left edge — yield if touch is
    // inside the sidebar OR in the far-left half of the viewport
    // (where the sidebar's open-from-anywhere gesture engages).
    // Without this filter, both handlers see a left-to-right swipe as
    // "their" gesture (sidebar opening, pin drawer closing) and
    // double-fire — closing the pin drawer when the user just meant
    // to open the sidebar. The pin drawer visually lives in the
    // right half of the viewport when open (width capped at
    // min(85vw, 320px) on mobile), so right-half-only is the
    // structurally correct bounding box for "swipe meant for me."
    const targetEl = e.target as Element | null;
    if (targetEl?.closest?.('#sidebar')) return;
    if (e.clientX < window.innerWidth / 2) return;
    if (targetOwnsHorizontalMotion(e.target)) return;

    active = true;
    pointerId = e.pointerId;
    startX = e.clientX; lastX = e.clientX;
    startY = e.clientY;
    lastT = e.timeStamp;
    widthPx = measureWidth() || 360;
    committed = false;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!active || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!committed) {
      if (e.cancelable) e.preventDefault();
      if (dx * dx + dy * dy < MIN_DISTANCE_PX * MIN_DISTANCE_PX) return;
      if (Math.abs(dy) >= Math.abs(dx)) { reset(); return; }
      // Close-gesture must be LEFT-TO-RIGHT (drag drawer back off the
      // right edge). Right-to-left is not us — bail so the sidebar
      // handler can potentially own it.
      if (dx <= 0) { reset(); return; }

      // Confirmed — committed close gesture.
      setInlineTransform(Math.max(0, Math.min(widthPx, dx)));
      committed = true;
      drawerEl.setPointerCapture?.(pointerId);
    } else {
      const translatePx = Math.max(0, Math.min(widthPx, dx));
      setInlineTransform(translatePx);
    }

    if (committed && e.cancelable) e.preventDefault();

    const dt = Math.max(1, e.timeStamp - lastT);
    lastVelocity = (e.clientX - lastX) / dt;
    lastX = e.clientX;
    lastT = e.timeStamp;
  };

  const onPointerEnd = (e: PointerEvent) => {
    if (!active || e.pointerId !== pointerId) return;
    const wasCommitted = committed;
    drawerEl.releasePointerCapture?.(pointerId);
    reset();
    if (!wasCommitted) return;

    const isCancel = e.type === 'pointercancel';
    const finalX = isCancel ? lastX : e.clientX;
    const dx = finalX - startX;
    const dt = Math.max(1, e.timeStamp - lastT);
    const velocity = isCancel ? lastVelocity : (e.clientX - lastX) / dt;

    let closeFinal: boolean;
    if (isCancel) {
      // iOS yanked the gesture mid-drag — honor committed direction
      // unless the last motion was a clear reversal back to open.
      const reversing = velocity < -VELOCITY_SNAP_PX_MS;
      closeFinal = !reversing;
    } else {
      if (velocity > VELOCITY_SNAP_PX_MS) closeFinal = true;
      else if (velocity < -VELOCITY_SNAP_PX_MS) closeFinal = false;
      else closeFinal = dx > widthPx / 2;
    }
    snap(closeFinal);
    diag(`[pin-drawer-swipe] release dx=${dx.toFixed(0)} v=${velocity.toFixed(2)} → ${closeFinal ? 'close' : 'reopen'}`);
  };

  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);
}
