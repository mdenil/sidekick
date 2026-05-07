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

import { log } from './util/log.ts';

/**
 * Floating button that copies the debug-panel contents to clipboard.
 * Created on-demand the first time a [swipe-trace] line lands so it
 * doesn't pollute non-debug sessions. Bottom-right, fixed position;
 * far from the left-edge swipe zone so tapping it doesn't trigger
 * the gesture handler.
 *
 * Removable along with the rest of the [swipe-trace] instrumentation
 * once the diagnosis is done.
 */
function ensureCopyButton(): void {
  if (document.getElementById('swipe-trace-copy')) return;
  const btn = document.createElement('button');
  btn.id = 'swipe-trace-copy';
  btn.type = 'button';
  btn.textContent = 'Copy log';
  btn.style.cssText = [
    'position:fixed', 'right:12px', 'bottom:12px', 'z-index:9999',
    'padding:10px 14px', 'border-radius:8px', 'border:1px solid var(--border, #333)',
    'background:var(--surface, #222)', 'color:var(--fg, #eee)',
    'font:13px/1.2 system-ui, sans-serif', 'box-shadow:0 4px 12px rgba(0,0,0,0.35)',
    'touch-action:manipulation',
  ].join(';');
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const dbg = document.getElementById('debug');
    const text = dbg?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied ✓';
      setTimeout(() => { btn.textContent = 'Copy log'; }, 1500);
    } catch (err) {
      btn.textContent = 'Copy failed';
      console.error('[swipe-trace-copy]', err);
    }
  });
  document.body.appendChild(btn);
}

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
  // Trace counter — suppress mid-drag pointermove spam to first 3 moves
  // per gesture so we can see how iOS is dispatching events without
  // flooding the log panel.
  let moveCount = 0;

  const isMobile = () => window.innerWidth < MOBILE_BREAKPOINT_PX;
  const measureWidth = () => sidebar.getBoundingClientRect().width || 280;

  const setInlineTransform = (translatePx: number) => {
    sidebar.style.transition = 'none';
    sidebar.style.transform = `translateX(${translatePx}px)`;
  };

  // While a swipe is being tracked, kill iOS's default scroll/zoom
  // gesture handling on the whole document. Without this, iOS Safari
  // intermittently decides the touch is a scroll (because the finger
  // sits over the still-mostly-hidden chat content during the early
  // part of the drag) and fires pointercancel with clientX reset to
  // 0 — which both ends our gesture and produces bogus snap decisions
  // (field-confirmed 2026-05-07).
  const setBodyTouchAction = (lock: boolean) => {
    document.body.style.touchAction = lock ? 'none' : '';
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
      // Restore default touch handling on body — re-enables vertical
      // scroll on chat content + sessions list.
      setBodyTouchAction(false);
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
    moveCount = 0;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (intent) return;             // gesture already in flight
    if (!isMobile()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // Mount the trace-copy button on the first pointerdown that reaches us
    // — by then we know the trace lines are flowing and the user might
    // want to grab a snapshot.
    ensureCopyButton();

    const expanded = opts.isExpanded();
    const x = e.clientX;
    const y = e.clientY;
    const ptType = e.pointerType;

    if (!expanded) {
      if (x > EDGE_ZONE_PX) {
        log(`[swipe-trace] pointerdown x=${x.toFixed(0)} y=${y.toFixed(0)} type=${ptType} REJECT (x > ${EDGE_ZONE_PX})`);
        return;
      }
      intent = 'opening';
    } else {
      if (!sidebar.contains(e.target as Node)) return;
      intent = 'closing';
    }

    pointerId = e.pointerId;
    startX = x; lastX = x;
    startY = y;
    lastT = e.timeStamp;
    widthPx = measureWidth() || 280;
    committed = false;
    moveCount = 0;
    log(`[swipe-trace] pointerdown ACCEPT intent=${intent} x=${x.toFixed(0)} y=${y.toFixed(0)} type=${ptType} pointerId=${pointerId}`);
    // Don't preventDefault yet — let normal taps inside the sidebar work
    // until horizontal motion confirms we're swiping.
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!intent || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    moveCount++;

    if (!committed) {
      if (intent === 'opening') {
        // Edge-touch declares intent on its own; commit on the first
        // real movement and preventDefault immediately so iOS doesn't
        // claim the gesture for vertical scroll (which would fire
        // pointercancel and snap the drawer closed mid-drag — this was
        // the "comes out a tiny bit and immediately hides" symptom).
        // Don't gate on horizontal vs. vertical dominance: the finger
        // is at the screen edge with no scrollable content under it.
        if (dx === 0 && dy === 0) {
          log(`[swipe-trace] move#${moveCount} no-op (dx=0 dy=0) cancelable=${e.cancelable}`);
          return;
        }
        widthPx = 280;
        // Apply inline transform first to avoid a one-frame flash of
        // the fully-open panel before the transform takes effect.
        setInlineTransform(-widthPx + Math.max(0, dx));
        opts.setExpanded(true);
        log(`[swipe-trace] move#${moveCount} COMMIT opening dx=${dx.toFixed(0)} dy=${dy.toFixed(0)} cancelable=${e.cancelable}`);
      } else {
        // Closing: require horizontal dominance before stealing the
        // gesture from vertical scroll on the sessions list.
        if (Math.abs(dx) < HORIZ_INTENT_PX) {
          if (moveCount <= 3) log(`[swipe-trace] move#${moveCount} closing-wait dx=${dx.toFixed(0)} dy=${dy.toFixed(0)} (need |dx|>=${HORIZ_INTENT_PX})`);
          return;
        }
        if (Math.abs(dy) > Math.abs(dx)) {
          log(`[swipe-trace] move#${moveCount} closing-ABORT vertical-dominant dx=${dx.toFixed(0)} dy=${dy.toFixed(0)}`);
          reset();
          return;
        }
        widthPx = measureWidth() || 280;
        setInlineTransform(Math.min(0, dx));
        log(`[swipe-trace] move#${moveCount} COMMIT closing dx=${dx.toFixed(0)} dy=${dy.toFixed(0)}`);
      }
      committed = true;
      sidebar.setPointerCapture?.(pointerId);
      // Lock body touch-action to none so iOS doesn't interpret the
      // ongoing drag as a scroll and fire pointercancel.
      setBodyTouchAction(true);
    } else {
      const translatePx = intent === 'opening'
        ? Math.max(-widthPx, Math.min(0, -widthPx + dx))
        : Math.max(-widthPx, Math.min(0, dx));
      setInlineTransform(translatePx);
      if (moveCount <= 5 || moveCount % 10 === 0) {
        log(`[swipe-trace] move#${moveCount} drag dx=${dx.toFixed(0)} dy=${dy.toFixed(0)} translate=${translatePx.toFixed(0)} cancelable=${e.cancelable}`);
      }
    }

    // Once committed, suppress browser scroll/click defaults along this
    // gesture. cancelable check guards against passive-listener cases.
    if (committed && e.cancelable) e.preventDefault();

    lastX = e.clientX;
    lastT = e.timeStamp;
  };

  const onPointerEnd = (e: PointerEvent) => {
    if (!intent || e.pointerId !== pointerId) {
      log(`[swipe-trace] ${e.type} IGNORED (intent=${intent} eventPid=${e.pointerId} ours=${pointerId})`);
      return;
    }
    const wasCommitted = committed;
    const wasIntent = intent;
    const totalMoves = moveCount;
    sidebar.releasePointerCapture?.(pointerId);
    reset();

    if (!wasCommitted) {
      // No commit means we never set body touch-action either, so
      // nothing to undo here.
      log(`[swipe-trace] ${e.type} pre-commit (intent=${wasIntent} totalMoves=${totalMoves}) — leaving state untouched`);
      return;
    }

    // iOS Safari fires pointercancel with clientX/Y RESET TO 0 even
    // mid-drag (field-confirmed 2026-05-07: a successful 200-move drag
    // to a fully-open drawer produced `pointercancel dx=-16` because
    // e.clientX was 0). Trust the last good move coordinates instead;
    // velocity is unreliable on cancel so fall back to position-only.
    const isCancel = e.type === 'pointercancel';
    const finalX = isCancel ? lastX : e.clientX;
    const dx = finalX - startX;
    const dt = Math.max(1, e.timeStamp - lastT);
    const velocity = isCancel ? 0 : (e.clientX - lastX) / dt;  // px/ms

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
    log(`[swipe-trace] ${e.type} intent=${wasIntent} dx=${dx.toFixed(0)} (finalX=${finalX.toFixed(0)} ${isCancel ? 'from lastX' : 'from event'}) velocity=${velocity.toFixed(2)} totalMoves=${totalMoves} → snap=${openFinal ? 'OPEN' : 'CLOSE'}`);
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
