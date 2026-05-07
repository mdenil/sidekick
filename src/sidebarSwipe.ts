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

import { log } from './util/log.ts';

/**
 * Floating button that copies the debug-panel contents to clipboard.
 * Created on-demand the first time a [swipe-trace] line lands so it
 * doesn't pollute non-debug sessions. Bottom-right, fixed position;
 * removable along with the rest of the [swipe-trace] instrumentation
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
  let moveCount = 0;

  const isMobile = () => window.innerWidth < MOBILE_BREAKPOINT_PX;
  const measureWidth = () => sidebar.getBoundingClientRect().width || 280;

  const setInlineTransform = (translatePx: number) => {
    sidebar.style.transition = 'none';
    sidebar.style.transform = `translateX(${translatePx}px)`;
  };

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
    setTimeout(cleanup, SNAP_DURATION_MS + 60);
  };

  const reset = () => {
    intent = null;
    committed = false;
    pointerId = -1;
    moveCount = 0;
  };

  const onPointerDown = (e: PointerEvent) => {
    if (intent) {
      log(`[swipe-trace] pointerdown SKIP (intent already=${intent}) x=${e.clientX.toFixed(0)} y=${e.clientY.toFixed(0)}`);
      return;
    }
    if (!isMobile()) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    ensureCopyButton();

    const expanded = opts.isExpanded();
    const x = e.clientX;
    const y = e.clientY;

    if (!expanded) {
      intent = 'opening';
    } else {
      if (!sidebar.contains(e.target as Node)) {
        log(`[swipe-trace] pointerdown REJECT-closing (target outside sidebar) x=${x.toFixed(0)} y=${y.toFixed(0)} target=${(e.target as Element)?.tagName ?? '?'}`);
        return;
      }
      intent = 'closing';
    }

    pointerId = e.pointerId;
    startX = x; lastX = x;
    startY = y;
    lastT = e.timeStamp;
    widthPx = measureWidth() || 280;
    committed = false;
    moveCount = 0;
    log(`[swipe-trace] pointerdown ACCEPT intent=${intent} x=${x.toFixed(0)} y=${y.toFixed(0)} type=${e.pointerType} pid=${pointerId}`);
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!intent || e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    moveCount++;

    if (!committed) {
      // Pre-commit preventDefault: stop iOS Safari from classifying the
      // motion as a scroll before WE've classified it ourselves. Without
      // this, any vertical component during the first ~10px makes iOS
      // start scrolling, fire pointercancel, and kill the gesture before
      // we reach MIN_DISTANCE_PX. Tradeoff: if the user truly wanted a
      // vertical scroll, they have to lift and re-touch — same as
      // ChatGPT-iOS-style classify-then-route gesture.
      if (e.cancelable) e.preventDefault();

      const distSq = dx * dx + dy * dy;
      if (distSq < MIN_DISTANCE_PX * MIN_DISTANCE_PX) {
        if (moveCount <= 3 || moveCount % 5 === 0) {
          log(`[swipe-trace] move#${moveCount} pre-classify dx=${dx.toFixed(0)} dy=${dy.toFixed(0)} dist=${Math.sqrt(distSq).toFixed(0)}/${MIN_DISTANCE_PX} cancelable=${e.cancelable}`);
        }
        return;
      }

      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);
      if (absDy >= absDx) {
        log(`[swipe-trace] move#${moveCount} CLASSIFY=vertical → ABANDON dx=${dx.toFixed(0)} dy=${dy.toFixed(0)}`);
        reset();
        return;
      }
      if (intent === 'opening' && dx <= 0) {
        log(`[swipe-trace] move#${moveCount} CLASSIFY=horizontal-leftward → ABANDON-opening dx=${dx.toFixed(0)} dy=${dy.toFixed(0)}`);
        reset();
        return;
      }
      if (intent === 'closing' && dx >= 0) {
        log(`[swipe-trace] move#${moveCount} CLASSIFY=horizontal-rightward → ABANDON-closing dx=${dx.toFixed(0)} dy=${dy.toFixed(0)}`);
        reset();
        return;
      }

      log(`[swipe-trace] move#${moveCount} CLASSIFY=horizontal COMMIT intent=${intent} dx=${dx.toFixed(0)} dy=${dy.toFixed(0)}`);
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
      if (moveCount % 10 === 0) {
        log(`[swipe-trace] move#${moveCount} drag dx=${dx.toFixed(0)} dy=${dy.toFixed(0)} translate=${translatePx.toFixed(0)}`);
      }
    }

    if (committed && e.cancelable) e.preventDefault();

    lastX = e.clientX;
    lastT = e.timeStamp;
  };

  const onPointerEnd = (e: PointerEvent) => {
    if (!intent || e.pointerId !== pointerId) {
      // Only log if we had an intent (i.e. ours got reset between move and up).
      return;
    }
    const wasCommitted = committed;
    const wasIntent = intent;
    const totalMoves = moveCount;
    sidebar.releasePointerCapture?.(pointerId);
    reset();

    if (!wasCommitted) {
      log(`[swipe-trace] ${e.type} pre-commit (intent=${wasIntent} moves=${totalMoves}) — no snap`);
      return;
    }

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
    log(`[swipe-trace] ${e.type} intent=${wasIntent} dx=${dx.toFixed(0)} (finalX=${finalX.toFixed(0)} ${isCancel ? 'from lastX' : 'from event'}) velocity=${velocity.toFixed(2)} moves=${totalMoves} → snap=${openFinal ? 'OPEN' : 'CLOSE'}`);
    snap(openFinal);
  };

  window.addEventListener('pointerdown', onPointerDown, { passive: true });
  window.addEventListener('pointermove', onPointerMove, { passive: false });
  window.addEventListener('pointerup', onPointerEnd);
  window.addEventListener('pointercancel', onPointerEnd);
}
