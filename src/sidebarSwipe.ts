/**
 * @fileoverview Edge-swipe to open / drawer-swipe to close (mobile only).
 *
 * Two gestures:
 *   • Open  — pointerdown within EDGE_ZONE_PX of the left edge while the
 *             sidebar is collapsed. Class flips to .expanded immediately
 *             (so width becomes 280px) and inline transform follows the
 *             finger from -widthPx to 0.
 *   • Close — pointerdown on the open sidebar; we wait for >HORIZ_INTENT_PX
 *             of horizontal-dominant motion before committing, so vertical
 *             scrolls inside the sessions list aren't hijacked.
 *
 * On release, snap direction is decided by either velocity (>0.5 px/ms in
 * the corresponding direction) or position (past widthPx/2). The snap
 * itself is a CSS transition on the inline transform; once it ends we
 * clear the inline override and the existing class CSS holds the state.
 *
 * Desktop: no-op (window.innerWidth >= 700). The class CSS for desktop
 * doesn't translate the sidebar; the rail is always visible.
 */

// 36px edge zone makes the open gesture forgiving for thumb landings
// (24px was too narrow — finger needed near-perfect placement).
const EDGE_ZONE_PX = 36;
// Closing requires horizontal-dominant motion before stealing the gesture
// from vertical scroll on the sessions list.
const HORIZ_INTENT_PX = 8;
const VELOCITY_SNAP_PX_MS = 0.5;
const SNAP_DURATION_MS = 180;
const MOBILE_BREAKPOINT_PX = 700;

interface SwipeOptions {
  setExpanded: (exp: boolean) => void;
  isExpanded: () => boolean;
}

export function init(opts: SwipeOptions): void {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;

  type Intent = 'opening' | 'closing';
  let intent: Intent | null = null;
  let pointerId = -1;
  let committed = false;        // true once we've started tracking the finger visually
  let startX = 0, startY = 0;
  let lastX = 0, lastT = 0;
  let widthPx = 280;

  const isMobile = () => window.innerWidth < MOBILE_BREAKPOINT_PX;
  const measureWidth = () => sidebar.getBoundingClientRect().width || 280;

  const setInlineTransform = (translatePx: number) => {
    sidebar.style.transition = 'none';
    sidebar.style.transform = `translateX(${translatePx}px)`;
  };

  const snap = (open: boolean) => {
    const target = open ? 0 : -widthPx;
    // Re-enable transition so the inline transform interpolates from
    // current finger position to the snap target.
    sidebar.style.transition = `transform ${SNAP_DURATION_MS}ms ease`;
    sidebar.style.transform = `translateX(${target}px)`;

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      sidebar.removeEventListener('transitionend', onEnd);
      // Clear inline so the class CSS owns the steady state. Inline
      // and class CSS agree on the value, so no visual jump.
      sidebar.style.transform = '';
      sidebar.style.transition = '';
      // Toggle class last — body padding/sidebar-expanded class flips,
      // sessionDrawer.refresh() runs only on open. Acceptable to defer
      // until snap completes; the visual state is already correct.
      opts.setExpanded(open);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName === 'transform') cleanup();
    };
    sidebar.addEventListener('transitionend', onEnd);
    // Safety net — transitionend doesn't fire if target equals current.
    setTimeout(cleanup, SNAP_DURATION_MS + 60);
  };

  const reset = () => {
    intent = null;
    committed = false;
    pointerId = -1;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (intent) return;             // gesture already in flight
    if (!isMobile()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const expanded = opts.isExpanded();
    const x = e.clientX;

    if (!expanded) {
      if (x > EDGE_ZONE_PX) return;
      intent = 'opening';
    } else {
      if (!sidebar.contains(e.target as Node)) return;
      intent = 'closing';
    }

    pointerId = e.pointerId;
    startX = x; lastX = x;
    startY = e.clientY;
    lastT = e.timeStamp;
    widthPx = measureWidth() || 280;
    committed = false;
    // Don't preventDefault yet — let normal taps inside the sidebar work
    // until horizontal motion confirms we're swiping.
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!intent || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!committed) {
      if (intent === 'opening') {
        // Edge-touch declares intent on its own; commit on the first
        // real movement and preventDefault immediately so iOS doesn't
        // claim the gesture for vertical scroll (which would fire
        // pointercancel and snap the drawer closed mid-drag — this was
        // the "comes out a tiny bit and immediately hides" symptom).
        // Don't gate on horizontal vs. vertical dominance: the finger
        // is at the screen edge with no scrollable content under it.
        if (dx === 0 && dy === 0) return;
        widthPx = 280;
        // Apply inline transform first to avoid a one-frame flash of
        // the fully-open panel before the transform takes effect.
        setInlineTransform(-widthPx + Math.max(0, dx));
        opts.setExpanded(true);
      } else {
        // Closing: require horizontal dominance before stealing the
        // gesture from vertical scroll on the sessions list.
        if (Math.abs(dx) < HORIZ_INTENT_PX) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          reset();
          return;
        }
        widthPx = measureWidth() || 280;
        setInlineTransform(Math.min(0, dx));
      }
      committed = true;
      sidebar.setPointerCapture?.(pointerId);
    } else {
      const translatePx = intent === 'opening'
        ? Math.max(-widthPx, Math.min(0, -widthPx + dx))
        : Math.max(-widthPx, Math.min(0, dx));
      setInlineTransform(translatePx);
    }

    // Once committed, suppress browser scroll/click defaults along this
    // gesture. cancelable check guards against passive-listener cases.
    if (committed && e.cancelable) e.preventDefault();

    lastX = e.clientX;
    lastT = e.timeStamp;
  };

  const onPointerEnd = (e: PointerEvent) => {
    if (!intent || e.pointerId !== pointerId) return;
    const wasCommitted = committed;
    const wasIntent = intent;
    sidebar.releasePointerCapture?.(pointerId);
    reset();

    if (!wasCommitted) return;     // never visually moved — leave as-is

    const dx = e.clientX - startX;
    // Use last-segment velocity for snap decision — captures flicks even
    // when the user pauses mid-drag.
    const dt = Math.max(1, e.timeStamp - lastT);
    const velocity = (e.clientX - lastX) / dt;  // px/ms, signed

    let openFinal: boolean;
    if (wasIntent === 'opening') {
      if (velocity > VELOCITY_SNAP_PX_MS) openFinal = true;
      else if (velocity < -VELOCITY_SNAP_PX_MS) openFinal = false;
      else openFinal = dx > widthPx / 2;
    } else {
      if (velocity < -VELOCITY_SNAP_PX_MS) openFinal = false;
      else if (velocity > VELOCITY_SNAP_PX_MS) openFinal = true;
      else openFinal = dx > -widthPx / 2;
    }
    snap(openFinal);
  };

  // Use window so we receive moves even after the pointer leaves the
  // narrow edge zone or drifts beyond the sidebar. passive: false on
  // pointermove so preventDefault works on iOS Safari.
  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);
}
