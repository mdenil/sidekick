/**
 * @fileoverview Swipe-to-open / swipe-to-close drawer (mobile only).
 *
 * Gesture model (mimics ChatGPT iOS):
 *   • Pointerdown anywhere on screen registers intent (opening when
 *     drawer is collapsed, closing when expanded). Nothing else happens
 *     until the gesture is classified.
 *   • Once total displacement crosses MIN_DISTANCE_PX (~3-4 chars, the
 *     minimum that feels intentional), classify as horizontal vs.
 *     vertical: if |dy| >= |dx|, abandon and let the browser scroll;
 *     otherwise commit as a drawer drag and ignore dy from then on.
 *   • The 45° boundary is inclusive of vertical (ties go to vertical
 *     scroll), making the gesture appropriately predisposed to scroll.
 *
 * On release, snap direction is decided by velocity (>0.5 px/ms) or
 * position (past widthPx/2). Snap is a CSS transition on the inline
 * transform; once it ends we clear the inline override and class CSS
 * holds the steady state.
 *
 * Desktop: no-op (window.innerWidth >= 700).
 */

// ~3-4 character widths in chat font; the minimum motion that feels
// like a deliberate drag rather than a tap or scroll wobble. Below
// this we don't classify or commit, so taps/clicks pass through.
const MIN_DISTANCE_PX = 30;
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
  let committed = false;
  let startX = 0, startY = 0;
  let lastX = 0, lastT = 0;
  let widthPx = 280;

  const isMobile = () => window.innerWidth < MOBILE_BREAKPOINT_PX;
  const measureWidth = () => sidebar.getBoundingClientRect().width || 280;

  const setInlineTransform = (translatePx: number) => {
    sidebar.style.transition = 'none';
    sidebar.style.transform = `translateX(${translatePx}px)`;
  };

  // While a swipe is committed, kill iOS's default scroll/zoom gesture
  // handling on the whole document — otherwise iOS Safari intermittently
  // decides the touch is a scroll mid-drag and fires pointercancel with
  // clientX reset to 0.
  const setBodyTouchAction = (lock: boolean) => {
    document.body.style.touchAction = lock ? 'none' : '';
  };

  const snap = (open: boolean) => {
    const target = open ? 0 : -widthPx;
    sidebar.style.transition = `transform ${SNAP_DURATION_MS}ms ease`;
    sidebar.style.transform = `translateX(${target}px)`;

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      sidebar.removeEventListener('transitionend', onEnd);
      sidebar.style.transform = '';
      sidebar.style.transition = '';
      setBodyTouchAction(false);
      opts.setExpanded(open);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName === 'transform') cleanup();
    };
    sidebar.addEventListener('transitionend', onEnd);
    // transitionend doesn't fire if target equals current.
    setTimeout(cleanup, SNAP_DURATION_MS + 60);
  };

  const reset = () => {
    intent = null;
    committed = false;
    pointerId = -1;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (intent) return;
    if (!isMobile()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    const expanded = opts.isExpanded();

    if (!expanded) {
      // Anywhere on screen is a candidate; classification on first move
      // decides whether this is a drawer-open or just a scroll.
      intent = 'opening';
    } else {
      // When drawer is open, only swipes that start on the drawer body
      // count — taps elsewhere should not be hijacked into close-drags.
      if (!sidebar.contains(e.target as Node)) return;
      intent = 'closing';
    }

    pointerId = e.pointerId;
    startX = e.clientX; lastX = e.clientX;
    startY = e.clientY;
    lastT = e.timeStamp;
    widthPx = measureWidth() || 280;
    committed = false;
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!intent || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!committed) {
      // Wait for enough motion to classify direction.
      if (dx * dx + dy * dy < MIN_DISTANCE_PX * MIN_DISTANCE_PX) return;

      // Vertical-dominant (or 45°) — let the browser scroll.
      if (Math.abs(dy) >= Math.abs(dx)) { reset(); return; }

      // Horizontal but in the wrong direction for the current intent.
      if (intent === 'opening' && dx <= 0) { reset(); return; }
      if (intent === 'closing' && dx >= 0) { reset(); return; }

      if (intent === 'opening') {
        widthPx = 280;
        setInlineTransform(Math.max(-widthPx, Math.min(0, -widthPx + dx)));
        opts.setExpanded(true);
      } else {
        widthPx = measureWidth() || 280;
        setInlineTransform(Math.max(-widthPx, Math.min(0, dx)));
      }
      committed = true;
      sidebar.setPointerCapture?.(pointerId);
      setBodyTouchAction(true);
    } else {
      const translatePx = intent === 'opening'
        ? Math.max(-widthPx, Math.min(0, -widthPx + dx))
        : Math.max(-widthPx, Math.min(0, dx));
      setInlineTransform(translatePx);
    }

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

    if (!wasCommitted) return;

    // iOS Safari fires pointercancel with clientX/Y RESET TO 0 even
    // mid-drag — trust the last good move coordinates instead. Velocity
    // is unreliable on cancel so fall back to position-only.
    const isCancel = e.type === 'pointercancel';
    const finalX = isCancel ? lastX : e.clientX;
    const dx = finalX - startX;
    const dt = Math.max(1, e.timeStamp - lastT);
    const velocity = isCancel ? 0 : (e.clientX - lastX) / dt;

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

  // Use window so we receive moves even after the pointer drifts
  // beyond the sidebar. passive: false on pointermove so preventDefault
  // works on iOS Safari.
  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);
}
