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
 * Snap on release:
 *   • pointerup: velocity (>0.5 px/ms) or position (past widthPx/2)
 *     decides the snap direction.
 *   • pointercancel: iOS Safari standalone-PWA fires this mid-drag for
 *     system-level gestures we can't suppress (edge takeovers, arbiter
 *     handoffs — touch-action: none does NOT stop them). The user was
 *     still actively dragging, so honor the committed direction unless
 *     the last observed motion was a clear reversal.
 *
 * Desktop: no-op (window.innerWidth >= 700).
 */

// ~3-4 character widths in chat font; the minimum motion that feels
// like a deliberate drag rather than a tap or scroll wobble.
const MIN_DISTANCE_PX = 30;
const VELOCITY_SNAP_PX_MS = 0.5;
const SNAP_DURATION_MS = 180;
const MOBILE_BREAKPOINT_PX = 700;
// Only initiate the open-drawer gesture from the left edge of the
// viewport — same affordance as iOS system back-swipe. Without this,
// any rightward drag anywhere on screen (text selection in the
// composer, a slider drag, horizontal scroll in a code block) gets
// hijacked because we'd already have applied `body.swipe-active`
// before the direction was classified.
const OPEN_EDGE_PX = 24;

/** Bail the gesture entirely if the touch landed on something that
 *  owns horizontal motion natively. Two cases:
 *    1. Text inputs (textarea / input / contenteditable) — drag = caret
 *       /selection range; iOS's text selection requires touch-action to
 *       stay default, but body.swipe-active sets touch-action:none.
 *    2. Range sliders — drag = value. Same touch-action conflict.
 *    3. Anything inside a horizontal-scrollable container (pre/code,
 *       wide tables) — drag = scrollLeft.
 *  Faster to short-circuit at pointerdown than to detect the conflict
 *  mid-gesture. */
function targetOwnsHorizontalMotion(target: EventTarget | null): boolean {
  let el = target as Element | null;
  if (!el) return false;
  while (el && el !== document.body) {
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) {
      // Range sliders use horizontal drag for value; text/url/search/etc.
      // use it for caret. checkbox/radio/button are point-only — fine.
      const t = el.type;
      if (t === 'range' || t === 'text' || t === 'search'
          || t === 'url' || t === 'email' || t === 'tel'
          || t === 'password' || t === 'number') return true;
    }
    if (el instanceof HTMLElement && el.isContentEditable) return true;
    // Horizontal-scrollable container — pre/code blocks (app.css:1488),
    // wide tables. Cheap check: computed overflow-x.
    if (el instanceof HTMLElement) {
      const ox = getComputedStyle(el).overflowX;
      if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth) return true;
    }
    el = el.parentElement;
  }
  return false;
}

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
  // Most recent move's instantaneous velocity (px/ms). Used on
  // pointercancel since the cancel event itself has bogus clientX
  // and we can't compute velocity from it.
  let lastVelocity = 0;

  const isMobile = () => window.innerWidth < MOBILE_BREAKPOINT_PX;
  const measureWidth = () => sidebar.getBoundingClientRect().width || 280;

  const setInlineTransform = (translatePx: number) => {
    sidebar.style.transition = 'none';
    sidebar.style.transform = `translateX(${translatePx}px)`;
  };

  // Toggles `body.swipe-active`, whose CSS rule sets `touch-action:
  // none !important` on body and every descendant. The class is
  // applied at pointerdown — NOT at commit — so iOS can't classify
  // the motion as a scroll before we classify it ourselves.
  // (touch-action on html/body alone doesn't propagate: scrollable
  // containers like .transcript and inner elements with explicit
  // `touch-action: manipulation` win over ancestor rules.)
  const setSwipeLock = (lock: boolean) => {
    document.body.classList.toggle('swipe-active', lock);
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
      setSwipeLock(false);
      opts.setExpanded(open);
    };
    const onEnd = (e: TransitionEvent) => {
      if (e.propertyName === 'transform') cleanup();
    };
    sidebar.addEventListener('transitionend', onEnd);
    setTimeout(cleanup, SNAP_DURATION_MS + 60);
  };

  const reset = () => {
    intent = null;
    committed = false;
    pointerId = -1;
    lastVelocity = 0;
    setSwipeLock(false);
  };

  const onPointerDown = (e: PointerEvent) => {
    if (intent) return;
    if (!isMobile()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    // Bail on inputs / sliders / horizontal-scrollables BEFORE applying
    // the swipe-lock CSS class. Otherwise the lock disables iOS's
    // native text-selection / range-drag / horizontal-scroll, even if
    // the gesture later gets rejected on direction (the user has
    // already missed the first frames of selection / drag / scroll).
    if (targetOwnsHorizontalMotion(e.target)) return;

    const expanded = opts.isExpanded();

    if (!expanded) {
      // Open-from-left gesture: only engage when the touch lands in
      // the left edge zone. Matches iOS system back-swipe affordance,
      // and frees the rest of the viewport for content interactions
      // (text selection in composer, taps on bubbles, etc.).
      if (e.clientX > OPEN_EDGE_PX) return;
      intent = 'opening';
    } else {
      if (!sidebar.contains(e.target as Node)) return;
      intent = 'closing';
    }

    pointerId = e.pointerId;
    startX = e.clientX; lastX = e.clientX;
    startY = e.clientY;
    lastT = e.timeStamp;
    widthPx = measureWidth() || 280;
    committed = false;
    setSwipeLock(true);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!intent || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    if (!committed) {
      // Pre-commit preventDefault belt-and-suspenders alongside the
      // body.swipe-active CSS lock — keeps iOS from classifying the
      // first few pointermoves as scroll before we classify them.
      if (e.cancelable) e.preventDefault();

      if (dx * dx + dy * dy < MIN_DISTANCE_PX * MIN_DISTANCE_PX) return;
      if (Math.abs(dy) >= Math.abs(dx)) { reset(); return; }
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
    } else {
      const translatePx = intent === 'opening'
        ? Math.max(-widthPx, Math.min(0, -widthPx + dx))
        : Math.max(-widthPx, Math.min(0, dx));
      setInlineTransform(translatePx);
    }

    if (committed && e.cancelable) e.preventDefault();

    const dt = Math.max(1, e.timeStamp - lastT);
    lastVelocity = (e.clientX - lastX) / dt;
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

    const isCancel = e.type === 'pointercancel';
    const finalX = isCancel ? lastX : e.clientX;
    const dx = finalX - startX;
    const dt = Math.max(1, e.timeStamp - lastT);
    const velocity = isCancel ? lastVelocity : (e.clientX - lastX) / dt;

    let openFinal: boolean;
    if (isCancel) {
      // iOS yanked the gesture; user was still dragging. Honor the
      // committed direction unless the last motion was a clear reversal.
      const reversing = wasIntent === 'opening'
        ? velocity < -VELOCITY_SNAP_PX_MS
        : velocity > VELOCITY_SNAP_PX_MS;
      openFinal = reversing
        ? wasIntent !== 'opening'
        : wasIntent === 'opening';
    } else if (wasIntent === 'opening') {
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

  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);
}
